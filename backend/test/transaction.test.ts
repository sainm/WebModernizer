import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { Store } from '../src/storage/store.js';
import type { ScanStatus } from '../src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '../../examples/legacy-app');
const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

const CSS_FILE = 'css/main.css';
const JS_FILE = 'js/legacy-events.js';

async function waitForScan(store: Store, scanId: string, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const scan = store.getScan(scanId);
    if (scan && TERMINAL.includes(scan.status)) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('scan did not finish in time');
}

interface Harness {
  dir: string;
  projectDir: string;
  store: Store;
  scanId: string;
  service: MigrationService;
}

const harnesses: Harness[] = [];

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-tx-'));
  const projectDir = join(dir, 'legacy-app');
  cpSync(exampleRoot, projectDir, { recursive: true });
  const store = new Store({ dataDir: join(dir, 'data') });
  const scans = new ScanManager(store);
  const project = store.createProject('Transaction Test', projectDir, defaultProjectConfig());
  const scan = store.createScan(project, defaultProjectConfig());
  scans.start(scan.id);
  await waitForScan(store, scan.id);
  const harness: Harness = { dir, projectDir, store, scanId: scan.id, service: new MigrationService(store) };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function pick(harness: Harness, ruleId: string, filePath: string) {
  const finding = harness.store
    .listAllFindings(harness.scanId)
    .find((item) => item.ruleId === ruleId && item.filePath === filePath);
  if (!finding) throw new Error(`no ${ruleId} in ${filePath}`);
  return finding;
}

describe('multi-file migration transactions', () => {
  it('applies every file under one session and reverts them together', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);
    const cssBefore = readFileSync(join(h.projectDir, CSS_FILE), 'utf8');
    const jsBefore = readFileSync(join(h.projectDir, JS_FILE), 'utf8');

    const result = await h.service.execute(h.scanId, [cssFinding.id, jsFinding.id]);
    expect(result.ok).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.executions).toHaveLength(2);

    const sessions = new Set(result.executions.map((execution) => execution.sessionId));
    const batches = new Set(result.executions.map((execution) => execution.batchId));
    expect(sessions.size).toBe(1);
    expect(sessions.has(null)).toBe(false);
    // Different files are different write units, but the same transaction.
    expect(batches.size).toBe(2);

    expect(readFileSync(join(h.projectDir, CSS_FILE), 'utf8')).not.toBe(cssBefore);
    expect(readFileSync(join(h.projectDir, JS_FILE), 'utf8')).not.toBe(jsBefore);

    const sessionId = result.executions[0].sessionId as string;
    const rollback = h.service.rollbackSession(sessionId);
    expect(rollback.ok).toBe(true);
    expect(rollback.affectedFindings).toBe(2);

    expect(readFileSync(join(h.projectDir, CSS_FILE), 'utf8')).toBe(cssBefore);
    expect(readFileSync(join(h.projectDir, JS_FILE), 'utf8')).toBe(jsBefore);
    for (const execution of result.executions) {
      expect(h.store.getFinding(execution.findingId)?.status).toBe('READY_FOR_MIGRATION');
      expect(h.store.getMigration(execution.id)?.executionStatus).toBe('ROLLED_BACK');
    }

    expect(h.service.rollbackSession(sessionId).ok).toBe(false);
  });

  it('writes nothing at all when one file changed after the scan', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);

    // Simulate an edit between scan and apply: the confirmed plan is now stale.
    const jsPath = join(h.projectDir, JS_FILE);
    const jsTouched = `${readFileSync(jsPath, 'utf8')}\n// edited outside the tool\n`;
    writeFileSync(jsPath, jsTouched);
    const cssBefore = readFileSync(join(h.projectDir, CSS_FILE), 'utf8');

    const result = await h.service.execute(h.scanId, [cssFinding.id, jsFinding.id]);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.executions).toHaveLength(0);
    expect(result.failures.map((failure) => failure.filePath)).toContain(JS_FILE);

    // The healthy file must not be touched either: this is the point of the transaction.
    expect(readFileSync(join(h.projectDir, CSS_FILE), 'utf8')).toBe(cssBefore);
    expect(readFileSync(jsPath, 'utf8')).toBe(jsTouched);
    expect(h.store.listMigrations(h.scanId)).toHaveLength(0);
  });

  it('excludes findings that cannot be applied instead of blocking the others', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    // WL-JS-003 has no recipe at all: it must be excluded, not abort the transaction.
    const manual = pick(h, 'WL-JS-003', JS_FILE);

    const result = await h.service.execute(h.scanId, [cssFinding.id, manual.id]);
    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(1);
    expect(result.failures.map((failure) => failure.findingId)).toContain(manual.id);
    expect(result.executions[0].filePath).toBe(CSS_FILE);
  });

  it('refuses a session rollback when a migrated file drifted afterwards', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);
    const result = await h.service.execute(h.scanId, [cssFinding.id, jsFinding.id]);
    expect(result.ok).toBe(true);

    const cssPath = join(h.projectDir, CSS_FILE);
    const jsPath = join(h.projectDir, JS_FILE);
    const migratedCss = readFileSync(cssPath, 'utf8');
    const migratedJs = readFileSync(jsPath, 'utf8');
    writeFileSync(cssPath, `${migratedCss}\n/* hand edited after migration */\n`);

    const sessionId = result.executions[0].sessionId as string;
    const rollback = h.service.rollbackSession(sessionId);
    expect(rollback.ok).toBe(false);
    expect(rollback.reason).toMatch(/changed after the migration/);

    // Nothing was reverted: the healthy file still holds exactly its migrated content,
    // and the drifted file keeps the manual edit instead of being restored.
    expect(readFileSync(jsPath, 'utf8')).toBe(migratedJs);
    expect(readFileSync(cssPath, 'utf8')).toContain('hand edited after migration');
  });
});

describe('plan binding between preview and execute', () => {
  it('executes exactly the plan that was previewed', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);

    const plan = h.service.preview({ scanTaskId: h.scanId, findingIds: [cssFinding.id, jsFinding.id] });
    expect(plan.planHash).toMatch(/^[0-9a-f]{16,}$/);

    const result = await h.service.execute(
      h.scanId,
      [cssFinding.id, jsFinding.id],
      { expectedPlanHash: plan.planHash },
    );
    expect(result.ok).toBe(true);
    expect(result.planHash).toBe(plan.planHash);
    expect(result.executions).toHaveLength(2);
  });

  it('digests the same tree to the same hash, and a changed tree to a different one', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const first = h.service.preview({ scanTaskId: h.scanId, findingIds: [cssFinding.id] });
    const second = h.service.preview({ scanTaskId: h.scanId, findingIds: [cssFinding.id] });
    expect(second.planHash).toBe(first.planHash);

    // A different finding set is a different plan.
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);
    const wider = h.service.preview({ scanTaskId: h.scanId, findingIds: [cssFinding.id, jsFinding.id] });
    expect(wider.planHash).not.toBe(first.planHash);
  });

  it('refuses to apply a plan that no longer matches what was reviewed', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);
    const cssBefore = readFileSync(join(h.projectDir, CSS_FILE), 'utf8');

    // Preview one finding, then try to apply the plan while asking for two.
    const plan = h.service.preview({ scanTaskId: h.scanId, findingIds: [cssFinding.id] });
    const result = await h.service.execute(
      h.scanId,
      [cssFinding.id, jsFinding.id],
      { expectedPlanHash: plan.planHash },
    );

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.executions).toHaveLength(0);
    expect(result.failures[0].reason).toContain('plan changed');
    // Nothing on disk, and nothing recorded.
    expect(readFileSync(join(h.projectDir, CSS_FILE), 'utf8')).toBe(cssBefore);
    expect(h.store.listMigrations(h.scanId)).toHaveLength(0);
  });
});

describe('write-ahead claims', () => {
  it('leaves no claim behind when a write fails and the transaction is compensated', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);
    const cssBefore = readFileSync(join(h.projectDir, CSS_FILE), 'utf8');

    // The CSS file is written first (files are ordered by path); blocking the js directory makes
    // the second write fail, which is the case that has to compensate the first one.
    const jsDir = join(h.projectDir, 'js');
    const originalMode = statSync(jsDir).mode & 0o777;
    chmodSync(jsDir, 0o500);
    try {
      const result = await h.service.execute(h.scanId, [cssFinding.id, jsFinding.id]);
      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(true);
      expect(result.failures[0].reason).toContain('Write failed');

      // Everything is back where it started, and no row claims otherwise.
      expect(readFileSync(join(h.projectDir, CSS_FILE), 'utf8')).toBe(cssBefore);
      expect(h.store.listMigrations(h.scanId)).toHaveLength(0);
      for (const finding of [cssFinding, jsFinding]) {
        expect(h.store.getFinding(finding.id)?.status).not.toBe('MIGRATED');
      }
    } finally {
      chmodSync(jsDir, originalMode);
    }
  });

  it('rolls back a claim whose write landed but was never confirmed', async () => {
    const h = await setup();
    const finding = pick(h, 'WL-JS-001', JS_FILE);
    const before = readFileSync(join(h.projectDir, JS_FILE), 'utf8');

    const result = await h.service.execute(h.scanId, [finding.id]);
    expect(result.ok).toBe(true);
    const [row] = h.store.listMigrations(h.scanId);
    expect(row.executionStatus).toBe('APPLIED');

    // The state a process killed between the write and the confirmation leaves behind.
    h.store.updateMigration(row.id, { executionStatus: 'PENDING' });
    expect(readFileSync(join(h.projectDir, JS_FILE), 'utf8')).not.toBe(before);

    const rollback = h.service.rollbackSession(result.sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(join(h.projectDir, JS_FILE), 'utf8')).toBe(before);
    expect(h.store.getMigration(row.id)?.executionStatus).toBe('ROLLED_BACK');
  });

  it('clears a claim whose write never happened without rewriting the file', async () => {
    const h = await setup();
    const finding = pick(h, 'WL-JS-001', JS_FILE);

    const result = await h.service.execute(h.scanId, [finding.id]);
    expect(result.ok).toBe(true);
    const [row] = h.store.listMigrations(h.scanId);

    // Undo the write behind the service's back and mark the claim unconfirmed: this is a
    // transaction that died before the file was touched.
    copyFileSync(row.backupPath, join(h.projectDir, JS_FILE));
    h.store.updateMigration(row.id, { executionStatus: 'PENDING' });
    const atRest = readFileSync(join(h.projectDir, JS_FILE), 'utf8');

    const rollback = h.service.rollbackSession(result.sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(join(h.projectDir, JS_FILE), 'utf8')).toBe(atRest);
    expect(h.store.getMigration(row.id)?.executionStatus).toBe('ROLLED_BACK');
  });
});

describe('rollback while a migration is running', () => {
  it('refuses instead of restoring bytes a running migration is about to rewrite', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);

    const first = await h.service.execute(h.scanId, [cssFinding.id]);
    expect(first.ok).toBe(true);

    // Hold the second migration inside its visual capture: that is the only await between reading
    // the file and writing it, so it is the only moment a rollback can land in between.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = h.service.execute(h.scanId, [jsFinding.id], {
      visual: {
        pages: [{ pageKey: 'p', url: 'http://localhost:5173/' }],
        capture: async () => {
          await gate;
          return null;
        },
      },
    });
    await new Promise((done) => setTimeout(done, 20));

    const refused = h.service.rollbackSession(first.sessionId);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/migration is running/);

    release();
    const second = await running;
    expect(second.ok).toBe(true);

    // Once it has finished, the same rollback goes through.
    expect(h.service.rollbackSession(first.sessionId).ok).toBe(true);
  });
});

describe('concurrent migrations', () => {
  it('does not lose an edit when two migrations touch the same project at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weblift-race-'));
    const projectDir = join(dir, 'project');
    mkdirSync(join(projectDir, 'js'), { recursive: true });
    const target = join(projectDir, 'js/two.js');
    writeFileSync(
      target,
      `function boot() {
  document.getElementById('a').attachEvent('onclick', first);
  document.getElementById('b').attachEvent('onclick', second);
}
`,
    );

    const store = new Store({ dataDir: join(dir, 'data') });
    harnesses.push({ dir, projectDir, store, scanId: '', service: new MigrationService(store) });
    const config = defaultProjectConfig();
    const project = store.createProject('Concurrency Test', projectDir, config);
    const scan = store.createScan(project, config);
    new ScanManager(store).start(scan.id);
    await waitForScan(store, scan.id);

    const findings = store.listAllFindings(scan.id).filter((finding) => finding.ruleId === 'WL-JS-001');
    expect(findings).toHaveLength(2);

    // The capture is the await that used to sit between "prepare" and "write": long enough for a
    // second execute() to prepare from the same bytes and then overwrite the first one's result.
    const capture = async (): Promise<null> => {
      await new Promise((done) => setTimeout(done, 25));
      return null;
    };
    const visual = { pages: [{ pageKey: 'p', url: 'http://localhost:5173/' }], capture };
    const service = new MigrationService(store);

    const [first, second] = await Promise.all([
      service.execute(scan.id, [findings[0].id], { visual }),
      service.execute(scan.id, [findings[1].id], { visual }),
    ]);

    const text = readFileSync(target, 'utf8');
    // One migration landed. The other was refused because the file had changed — not applied
    // silently on top, which is what used to happen and what lost the first edit.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(text.match(/addEventListener/g) ?? []).toHaveLength(1);
    expect(text.match(/attachEvent/g) ?? []).toHaveLength(1);

    const refused = first.ok ? second : first;
    expect(refused.aborted).toBe(true);
    expect(refused.failures[0].reason).toMatch(/changed after the scan/);

    // Exactly one session recorded, so the history matches the single file change.
    expect(new Set(store.listMigrations(scan.id).map((row) => row.sessionId)).size).toBe(1);
  });
});

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    const result = h.service.execute(h.scanId, [cssFinding.id, jsFinding.id]);
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

    const result = h.service.execute(h.scanId, [cssFinding.id, jsFinding.id]);
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

    const result = h.service.execute(h.scanId, [cssFinding.id, manual.id]);
    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(1);
    expect(result.failures.map((failure) => failure.findingId)).toContain(manual.id);
    expect(result.executions[0].filePath).toBe(CSS_FILE);
  });

  it('refuses a session rollback when a migrated file drifted afterwards', async () => {
    const h = await setup();
    const cssFinding = pick(h, 'WL-CSS-005', CSS_FILE);
    const jsFinding = pick(h, 'WL-JS-001', JS_FILE);
    const result = h.service.execute(h.scanId, [cssFinding.id, jsFinding.id]);
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

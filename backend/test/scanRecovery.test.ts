import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { newId, nowIso } from '../src/model/ids.js';
import type { ScanStatus } from '../src/model/types.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store, type ScanFileRow } from '../src/storage/store.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];
const DEAD_PID = 2_000_000_000;

const harnesses: Array<{ dir: string; store: Store }> = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

async function waitForScan(store: Store, scanId: string, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const scan = store.getScan(scanId);
    if (scan && TERMINAL.includes(scan.status)) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('scan did not finish in time');
}

function projectWith(count: number): { dir: string; root: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-recovery-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(
      join(root, 'js', `f${i}.js`),
      `function f${i}() {\n  document.getElementById('row${i}').attachEvent('onclick', handler);\n}\n`,
    );
  }
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  return { dir, root, store };
}

describe('crash-resumable scans', () => {
  it('persists finished files while the scan is still running', async () => {
    const { root, store } = projectWith(60);
    const config = defaultProjectConfig();
    const project = store.createProject('Flush while running', root, config);
    const scan = store.createScan(project, config, ruleSignature());

    const previousFlush = process.env.WEBLIFT_SCAN_FLUSH_EVERY;
    process.env.WEBLIFT_SCAN_FLUSH_EVERY = '5';
    let flushedDuringParsing = false;
    const original = store.insertScanBatch.bind(store);
    store.insertScanBatch = (scanTaskId, batch) => {
      const current = store.getScan(scan.id);
      if (current?.status === 'RUNNING' && current.phase === 'PARSING') flushedDuringParsing = true;
      original(scanTaskId, batch);
    };

    try {
      new ScanManager(store).start(scan.id);
      await waitForScan(store, scan.id);
    } finally {
      if (previousFlush === undefined) delete process.env.WEBLIFT_SCAN_FLUSH_EVERY;
      else process.env.WEBLIFT_SCAN_FLUSH_EVERY = previousFlush;
    }

    const finished = store.getScan(scan.id);
    expect(finished?.status).toBe('COMPLETED');
    expect(flushedDuringParsing).toBe(true);
    expect(finished?.scannedFileCount).toBe(60);
    expect(finished?.parsedFileCount).toBe(60);
    expect(finished?.failedFileCount).toBe(0);

    const rows = store.listScanFiles(scan.id);
    expect(rows).toHaveLength(60);
    expect(new Set(rows.map((row) => row.path)).size).toBe(60);
    expect(rows.every((row) => row.findingCount === 1)).toBe(true);
    expect(store.listAllFindings(scan.id)).toHaveLength(60);
    expect(store.listFileFacts(scan.id)).toHaveLength(60);
  });

  it('writes a batch atomically, so a failure cannot leave findings without their file row', async () => {
    const { root, store } = projectWith(1);
    const config = defaultProjectConfig();
    const project = store.createProject('Atomic batch', root, config);
    const first = store.createScan(project, config, ruleSignature());
    new ScanManager(store).start(first.id);
    await waitForScan(store, first.id);
    const sourceFinding = store.listAllFindings(first.id)[0];
    expect(sourceFinding).toBeDefined();

    const target = store.createScan(project, config, ruleSignature());
    const row: ScanFileRow = {
      id: 'fil_duplicate',
      scanTaskId: target.id,
      path: 'js/duplicate.js',
      language: 'javascript',
      size: 1,
      hash: 'hash',
      encoding: 'utf-8',
      parseStatus: 'PARSED',
      findingCount: 1,
      reused: false,
    };
    store.insertScanFiles([row]);

    expect(() =>
      store.insertScanBatch(target.id, {
        files: [{ ...row }],
        findings: [{ ...sourceFinding, id: newId('fnd'), scanTaskId: target.id }],
        problems: [],
        facts: [{ path: 'js/duplicate.js', imports: [], defines: [], calls: [] }],
        counts: { scanned: 1, parsed: 1, failed: 0, findings: 1, currentFile: null },
      }),
    ).toThrow();

    expect(store.listScanFiles(target.id)).toHaveLength(1);
    expect(store.listAllFindings(target.id)).toHaveLength(0);
    expect(store.listFileFacts(target.id)).toHaveLength(0);
    expect(store.getScan(target.id)?.scannedFileCount).toBe(0);
  });

  it('marks a RUNNING scan whose process is gone as failed, but leaves a live owner alone', () => {
    const { root, store } = projectWith(1);
    const config = defaultProjectConfig();
    const project = store.createProject('Reclaim', root, config);

    const live = store.createScan(project, config, ruleSignature());
    store.updateScan(live.id, { status: 'RUNNING', startedAt: nowIso(), runnerPid: process.pid });
    const dead = store.createScan(project, config, ruleSignature());
    store.updateScan(dead.id, { status: 'RUNNING', startedAt: nowIso(), runnerPid: DEAD_PID });

    new ScanManager(store);

    expect(store.getScan(live.id)?.status).toBe('RUNNING');
    const reclaimed = store.getScan(dead.id);
    expect(reclaimed?.status).toBe('FAILED');
    expect(reclaimed?.completedAt).not.toBeNull();
    expect(reclaimed?.errorSummary).toContain('stopped before completion');
  });

  it('resumes a crashed scan and keeps reference edges for reused files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weblift-resume-'));
    const root = join(dir, 'project');
    mkdirSync(join(root, 'js'), { recursive: true });
    writeFileSync(join(root, 'js', 'a.js'), 'function sharedHelper() {\n  return 1;\n}\n');
    writeFileSync(
      join(root, 'js', 'b.js'),
      'function boot() {\n  sharedHelper();\n  document.getElementById("row").attachEvent("onclick", handler);\n}\n',
    );
    writeFileSync(
      join(root, 'js', 'c.js'),
      'function c() {\n  document.getElementById("row").attachEvent("onclick", handler);\n}\n',
    );
    writeFileSync(
      join(root, 'js', 'd.js'),
      'function d() {\n  document.getElementById("row").attachEvent("onclick", handler);\n}\n',
    );
    const store = new Store({ dataDir: join(dir, 'data') });
    harnesses.push({ dir, store });
    const config = defaultProjectConfig();
    const project = store.createProject('Resume', root, config);
    const manager = new ScanManager(store);

    const first = store.createScan(project, config, ruleSignature());
    manager.start(first.id);
    await waitForScan(store, first.id);
    expect(store.getScan(first.id)?.status).toBe('COMPLETED');
    const firstRelations = store.listRelations(first.id);
    expect(
      firstRelations.some(
        (relation) =>
          relation.fromPath === 'js/b.js' && relation.toPath === 'js/a.js' && relation.kind === 'SHARED_FUNCTION_CALL',
      ),
    ).toBe(true);

    const prefix = ['js/a.js', 'js/b.js'];
    const crashed = store.createScan(project, config, ruleSignature());
    const prefixRows = store.listScanFiles(first.id).filter((row) => prefix.includes(row.path));
    store.insertScanFiles(prefixRows.map((row) => ({ ...row, id: newId('fil'), scanTaskId: crashed.id })));
    const prefixFindings = store.listAllFindings(first.id).filter((finding) => prefix.includes(finding.filePath));
    store.insertFindings(prefixFindings.map((finding) => ({ ...finding, id: newId('fnd'), scanTaskId: crashed.id })));
    store.insertFileFacts(
      crashed.id,
      store.listFileFacts(first.id).filter((fact) => prefix.includes(fact.path)),
    );
    store.updateScan(crashed.id, {
      status: 'RUNNING',
      startedAt: nowIso(),
      runnerPid: DEAD_PID,
      totalFileCount: 4,
      scannedFileCount: prefix.length,
      parsedFileCount: prefix.length,
      findingCount: prefixFindings.length,
    });

    const recovery = new ScanManager(store);
    expect(store.getScan(crashed.id)?.status).toBe('FAILED');

    const resumed = store.createScan(project, config, ruleSignature());
    recovery.start(resumed.id);
    await waitForScan(store, resumed.id);

    const resumedScan = store.getScan(resumed.id);
    expect(resumedScan?.status).toBe('COMPLETED');
    expect(resumedScan?.scannedFileCount).toBe(4);
    const rows = store.listScanFiles(resumed.id);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.reused).map((row) => row.path).sort()).toEqual(prefix);
    expect(store.listAllFindings(resumed.id).some((finding) => finding.filePath === 'js/b.js')).toBe(true);
    expect(store.listFileFacts(resumed.id)).toHaveLength(4);

    const relations = store.listRelations(resumed.id);
    expect(
      relations.some(
        (relation) =>
          relation.fromPath === 'js/b.js' && relation.toPath === 'js/a.js' && relation.kind === 'SHARED_FUNCTION_CALL',
      ),
    ).toBe(true);
    expect(store.getScanLog(resumed.id).some((entry) => entry.message.includes('no stored reference facts'))).toBe(false);
  });
});

import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';
import type { ScanStatus } from '../src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '../../examples/legacy-app');
const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

const harnesses: Array<{ dir: string; store: Store }> = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

async function waitForScan(store: Store, scanId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const scan = store.getScan(scanId);
    if (scan && TERMINAL.includes(scan.status)) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('scan did not finish in time');
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-inc-'));
  const projectDir = join(dir, 'legacy-app');
  cpSync(exampleRoot, projectDir, { recursive: true });
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });

  const scans = new ScanManager(store);
  const config = defaultProjectConfig();
  const project = store.createProject('Incremental Test', projectDir, config);

  const runScan = async (signature: string | null = ruleSignature()) => {
    const scan = store.createScan(project, config, signature);
    scans.start(scan.id);
    await waitForScan(store, scan.id);
    return scan.id;
  };

  return { store, scans, config, project, projectDir, runScan };
}

/** A project large enough that a scan can be interrupted while it is still working. */
const LARGE_FILE_COUNT = 120;

const LARGE_FILE_SOURCE = `function boot() {
  var all = document.all;
  var el = document.getElementById('row');
  el.attachEvent('onclick', handler);
  if (el.style.currentStyle) return all.length;
  window.navigate('/legacy/list.jsp');
  return el.attachEvent;
}
`;

async function setupLarge() {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-inc-large-'));
  const projectDir = join(dir, 'legacy-large');
  mkdirSync(join(projectDir, 'js'), { recursive: true });
  for (let index = 0; index < LARGE_FILE_COUNT; index += 1) {
    const name = `js/module-${String(index).padStart(4, '0')}.js`;
    writeFileSync(join(projectDir, name), LARGE_FILE_SOURCE, 'utf8');
  }
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });

  const scans = new ScanManager(store);
  const config = defaultProjectConfig();
  const project = store.createProject('Interrupted Scan', projectDir, config);

  return { store, scans, config, project, projectDir };
}

describe('incremental scans', () => {
  it('reuses every unchanged file and produces the same results', async () => {
    const { store, runScan } = await setup();
    const first = await runScan();
    const firstFiles = store.listScanFiles(first);
    const firstFindings = store.listAllFindings(first);

    expect(firstFiles.every((file) => file.reused === false)).toBe(true);
    expect(firstFindings.length).toBeGreaterThan(80);

    const second = await runScan();
    const secondFiles = store.listScanFiles(second);
    const secondFindings = store.listAllFindings(second);

    // Same file count, every one reused, identical finding count and locations.
    expect(secondFiles).toHaveLength(firstFiles.length);
    expect(secondFiles.every((file) => file.reused)).toBe(true);
    expect(secondFindings).toHaveLength(firstFindings.length);
    expect(secondFindings.map((f) => `${f.filePath}:${f.startLine}:${f.ruleId}`)).toEqual(
      firstFindings.map((f) => `${f.filePath}:${f.startLine}:${f.ruleId}`),
    );

    // Findings belong to the new scan, not the old one.
    expect(new Set(secondFindings.map((f) => f.scanTaskId))).toEqual(new Set([second]));
    expect(secondFindings.every((f) => !firstFindings.some((old) => old.id === f.id))).toBe(true);

    // References of reused files are carried over instead of silently disappearing.
    expect(store.listRelations(second).length).toBeGreaterThan(0);
  });

  it('re-parses only the file that changed', async () => {
    const { store, projectDir, runScan } = await setup();
    const first = await runScan();
    expect(store.listScanFiles(first).every((file) => !file.reused)).toBe(true);

    appendFileSync(join(projectDir, 'js/common.js'), '\n// touched between scans\n');

    const second = await runScan();
    const files = store.listScanFiles(second);
    const changed = files.filter((file) => file.path === 'js/common.js');
    expect(changed[0].reused).toBe(false);

    const others = files.filter((file) => file.path !== 'js/common.js');
    expect(others.every((file) => file.reused)).toBe(true);
  });

  it('refuses to reuse when the rule signature differs', async () => {
    const { store, runScan } = await setup();
    const first = await runScan();
    expect(store.listScanFiles(first).every((file) => !file.reused)).toBe(true);

    // Simulate a previous scan produced by a different rule set.
    store.db.prepare('UPDATE scan_task SET rule_signature = ? WHERE id = ?').run('different-rules', first);

    const second = await runScan();
    expect(store.listScanFiles(second).every((file) => !file.reused)).toBe(true);
  });

  it('does not reuse from an older scan when a newer one exists', async () => {
    const { store, runScan } = await setup();
    const first = await runScan();
    const second = await runScan();
    expect(store.listScanFiles(second).every((file) => file.reused)).toBe(true);

    const third = await runScan();
    // The newest completed scan is the reuse source, so counts stay stable.
    expect(store.listScanFiles(third).every((file) => file.reused)).toBe(true);
    expect(store.listAllFindings(third)).toHaveLength(store.listAllFindings(second).length);
    expect(store.listAllFindings(third)).toHaveLength(store.listAllFindings(first).length);
  });
});

describe('resuming after an interruption', () => {
  it('treats a cancelled scan as a reuse source', async () => {
    const { store, runScan } = await setup();
    const first = await runScan();
    const firstFindings = store.listAllFindings(first).length;

    // An interrupted scan: the run never reached its final phase.
    store.updateScan(first, { status: 'CANCELLED', completedAt: new Date().toISOString() });

    const second = await runScan();
    expect(store.listScanFiles(second).every((file) => file.reused)).toBe(true);
    expect(store.listAllFindings(second)).toHaveLength(firstFindings);
  });

  it('re-parses only the files the interrupted scan never finished', async () => {
    const { store, runScan } = await setup();
    const first = await runScan();
    const totalFindings = store.listAllFindings(first).length;

    // Simulate a scan that died after five files: drop the rest from storage.
    const files = store.listScanFiles(first);
    const dropped = files.slice(-5).map((file) => file.path);
    for (const path of dropped) {
      store.db.prepare('DELETE FROM scan_file WHERE scan_task_id = ? AND path = ?').run(first, path);
      store.db.prepare('DELETE FROM finding WHERE scan_task_id = ? AND file_path = ?').run(first, path);
    }
    store.updateScan(first, { status: 'FAILED', completedAt: new Date().toISOString(), errorSummary: 'simulated crash' });

    const second = await runScan();
    const secondFiles = store.listScanFiles(second);
    const reused = secondFiles.filter((file) => file.reused).map((file) => file.path);

    // The five missing files are parsed again; everything else is carried over.
    for (const path of dropped) expect(reused).not.toContain(path);
    expect(reused).toHaveLength(files.length - dropped.length);
    expect(store.listAllFindings(second)).toHaveLength(totalFindings);
  });

  it('still starts from scratch when the rule set changed since the interruption', async () => {
    const { store, runScan } = await setup();
    const first = await runScan();
    store.updateScan(first, { status: 'CANCELLED', completedAt: new Date().toISOString() });
    store.db.prepare('UPDATE scan_task SET rule_signature = ? WHERE id = ?').run('older-rules', first);

    const second = await runScan();
    expect(store.listScanFiles(second).every((file) => !file.reused)).toBe(true);
  });

  it('keeps the finished files when the scan is really cancelled midway', async () => {
    const { store, scans, config, project } = await setupLarge();
    const scan = store.createScan(project, config, ruleSignature());

    // Cancel from the progress stream: the scan is genuinely running, not finished.
    // The subscription has to follow start(), because a runner only exists from then on.
    let cancelAck = false;
    scans.start(scan.id);
    const unsubscribe = scans.subscribe(scan.id, (event) => {
      if (cancelAck) return;
      if (event.type === 'progress' && (event.progress?.scannedFiles ?? 0) >= 20) {
        cancelAck = scans.cancel(scan.id);
      }
    });
    await waitForScan(store, scan.id);
    unsubscribe();

    expect(cancelAck).toBe(true);
    expect(store.getScan(scan.id)?.status).toBe('CANCELLED');

    // A file is only stored once it is fully analysed, so a partial count is safe to resume from.
    const kept = store.listScanFiles(scan.id);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(LARGE_FILE_COUNT);
    expect(store.listAllFindings(scan.id).length).toBeGreaterThan(0);

    // The next scan resumes: everything already stored is reused, only the rest is parsed.
    const resumed = store.createScan(project, config, ruleSignature());
    scans.start(resumed.id);
    await waitForScan(store, resumed.id);

    const files = store.listScanFiles(resumed.id);
    expect(files).toHaveLength(LARGE_FILE_COUNT);
    expect(files.filter((file) => file.reused)).toHaveLength(kept.length);
    expect(store.getScan(resumed.id)?.status).toBe('COMPLETED');
  }, 60000);
});

import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
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
  const project = store.createProject('Incremental Test', projectDir, defaultProjectConfig());

  const runScan = async (signature: string | null = ruleSignature()) => {
    const scan = store.createScan(project, defaultProjectConfig(), signature);
    scans.start(scan.id);
    await waitForScan(store, scan.id);
    return scan.id;
  };

  return { store, projectDir, project, runScan };
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

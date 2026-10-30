import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-trend-'));
  const projectDir = join(dir, 'legacy-app');
  cpSync(exampleRoot, projectDir, { recursive: true });
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });

  const scans = new ScanManager(store);
  const config = defaultProjectConfig();
  const project = store.createProject('Trend Test', projectDir, config);
  const runScan = async () => {
    const scan = store.createScan(project, config, ruleSignature());
    scans.start(scan.id);
    await waitForScan(store, scan.id);
    return store.getScan(scan.id)!;
  };

  return { store, projectDir, project, runScan };
}

describe('scan trend', () => {
  it('records no delta for the very first scan', async () => {
    const { runScan } = await setup();
    const first = await runScan();
    expect(first.comparedScanId).toBeNull();
    expect(first.resolvedCount).toBe(0);
    expect(first.addedCount).toBe(0);
    expect(first.findingCount).toBeGreaterThan(80);
  });

  it('records a zero delta when nothing changed between two scans', async () => {
    const { runScan } = await setup();
    const first = await runScan();
    const second = await runScan();

    expect(second.comparedScanId).toBe(first.id);
    expect(second.resolvedCount).toBe(0);
    expect(second.addedCount).toBe(0);
    expect(second.findingCount).toBe(first.findingCount);
  });

  it('counts the findings of a rewritten file as fixed', async () => {
    const { store, projectDir, runScan } = await setup();
    const first = await runScan();
    const target = 'js/legacy-events.js';
    const before = store.listAllFindings(first.id).filter((finding) => finding.filePath === target);
    expect(before.length).toBeGreaterThan(0);

    // The developer rewrote the file by hand: identity is rule + path + snippet, so every
    // pattern that is gone now reads as fixed — no offset bookkeeping involved.
    unlinkSync(join(projectDir, target));
    const second = await runScan();

    expect(second.comparedScanId).toBe(first.id);
    expect(second.resolvedCount).toBe(before.length);
    expect(second.addedCount).toBe(0);
  });

  it('counts a newly added legacy pattern as introduced', async () => {
    const { runScan, projectDir } = await setup();
    const first = await runScan();

    writeFileSync(
      join(projectDir, 'js/added.js'),
      "document.getElementById('x').attachEvent('onclick', handler);\n",
    );
    const second = await runScan();

    expect(second.comparedScanId).toBe(first.id);
    expect(second.resolvedCount).toBe(0);
    expect(second.addedCount).toBe(1);
  });
});

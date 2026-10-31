import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import type { ScanStatus, ScanTask } from '../src/model/types.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];
const FILE = 'js/legacy.js';
const BROKEN = `function boot() {
  document.getElementById('row').attachEvent('onclick', handler);
}
`;
const REPAIRED = `function boot() {
  document.getElementById('row').addEventListener('click', handler);
}
`;

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
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('scan did not finish in time');
}

async function setup(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-verify-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Verification', root, config);
  const manager = new ScanManager(store);
  const scan = async (): Promise<ScanTask> => {
    const task = store.createScan(project, config, ruleSignature());
    manager.start(task.id);
    await waitForScan(store, task.id);
    return store.getScan(task.id) as ScanTask;
  };
  const attachEventFinding = (scanId: string) =>
    store.listAllFindings(scanId).find((finding) => finding.ruleId === 'WL-JS-001');
  return { file, store, scan, attachEventFinding };
}

describe('manual fix verification across scans', () => {
  it('fails a claimed fix that is still present, then validates it automatically after the code is repaired', async () => {
    const { file, store, scan, attachEventFinding } = await setup(BROKEN);

    const first = await scan();
    const original = attachEventFinding(first.id);
    expect(original).toBeDefined();
    store.updateFindingStatus(original!.id, 'FIXED_IN_CODE', 'user', null);

    const second = await scan();
    const current = attachEventFinding(second.id);
    expect(current?.status).toBe('VALIDATION_FAILED');
    expect(store.getFinding(original!.id)?.status).toBe('VALIDATION_FAILED');
    expect(
      store.getFindingHistory(original!.id).some(
        (entry) => entry.toStatus === 'VALIDATION_FAILED' && entry.actor === 'system:verification',
      ),
    ).toBe(true);
    expect(store.getScanLog(second.id).some((entry) => entry.message.includes('Manual fix verification'))).toBe(true);

    writeFileSync(file, REPAIRED);
    const third = await scan();
    expect(attachEventFinding(third.id)).toBeUndefined();
    expect(store.getFinding(current!.id)?.status).toBe('VALIDATED');
    expect(
      store.getFindingHistory(current!.id).some(
        (entry) => entry.toStatus === 'VALIDATED' && entry.actor === 'system:verification',
      ),
    ).toBe(true);
  });

  it('validates a claimed fix on the first scan that no longer reports it', async () => {
    const { file, store, scan, attachEventFinding } = await setup(BROKEN);

    const first = await scan();
    const original = attachEventFinding(first.id);
    expect(original).toBeDefined();
    store.updateFindingStatus(original!.id, 'FIXED_IN_CODE', 'user', 'replaced by addEventListener');

    writeFileSync(file, REPAIRED);
    const second = await scan();
    expect(attachEventFinding(second.id)).toBeUndefined();
    expect(store.getFinding(original!.id)?.status).toBe('VALIDATED');
    expect(
      store.getFindingHistory(original!.id).some(
        (entry) => entry.toStatus === 'VALIDATED' && entry.actor === 'system:verification',
      ),
    ).toBe(true);
  });
});

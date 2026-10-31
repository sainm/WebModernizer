import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import type { ScanStatus, ScanTask } from '../src/model/types.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];
const DEAD_PID = 2_000_000_000;
const FILE = 'js/legacy.js';
const SOURCE = `function boot() {
  document.getElementById('row').attachEvent('onclick', handler);
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

async function waitForUnlock(store: Store, projectId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (!store.getProjectLock(projectId)) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('project lock was not released');
}

async function setup(waitMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-queue-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, SOURCE);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Lock queue', root, config);
  const manager = new ScanManager(store, { lockWaitMs: waitMs });
  const service = new MigrationService(store, { lockWaitMs: waitMs });

  const scan: ScanTask = store.createScan(project, config, ruleSignature());
  manager.start(scan.id);
  await waitForScan(store, scan.id);
  await waitForUnlock(store, project.id);
  const finding = store.listAllFindings(scan.id).find((item) => item.ruleId === 'WL-JS-001');
  if (!finding) throw new Error('fixture finding missing');
  return { file, store, config, project, manager, service, scan, finding };
}

describe('bounded project lock waits', () => {
  it('queues a scan and starts it when the lock is released', async () => {
    const { store, config, project, manager } = await setup(800);
    expect(store.tryAcquireProjectLock(project.id, process.pid, 'foreign').ok).toBe(true);

    const scan = store.createScan(project, config, ruleSignature());
    const started = manager.start(scan.id);
    expect(started.ok).toBe(true);
    expect(started.queued).toBe(true);
    const queued = store.getScan(scan.id);
    expect(queued?.status).toBe('QUEUED');
    expect(queued?.waitingFor).toContain('Another operation is already running');

    setTimeout(() => store.releaseProjectLock(project.id, 'foreign'), 150);
    await waitForScan(store, scan.id);
    await waitForUnlock(store, project.id);
    const finished = store.getScan(scan.id);
    expect(finished?.status).toBe('COMPLETED');
    expect(finished?.waitingFor).toBeNull();
  });

  it('fails a queued scan with a timeout reason and leaves the owner alone', async () => {
    const { store, config, project, manager } = await setup(250);
    expect(store.tryAcquireProjectLock(project.id, process.pid, 'foreign').ok).toBe(true);

    const scan = store.createScan(project, config, ruleSignature());
    expect(manager.start(scan.id).queued).toBe(true);
    await waitForScan(store, scan.id);

    const failed = store.getScan(scan.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.waitingFor).toBeNull();
    expect(failed?.errorSummary).toContain('Timed out after');
    expect(store.getProjectLock(project.id)?.ownerToken).toBe('foreign');
    store.releaseProjectLock(project.id, 'foreign');
  });

  it('cancels a scan while it is waiting without taking the lock', async () => {
    const { store, config, project, manager } = await setup(5000);
    expect(store.tryAcquireProjectLock(project.id, process.pid, 'foreign').ok).toBe(true);

    const scan = store.createScan(project, config, ruleSignature());
    expect(manager.start(scan.id).queued).toBe(true);
    expect(store.getScan(scan.id)?.status).toBe('QUEUED');
    expect(manager.cancel(scan.id)).toBe(true);
    await waitForScan(store, scan.id);

    const cancelled = store.getScan(scan.id);
    expect(cancelled?.status).toBe('CANCELLED');
    expect(cancelled?.waitingFor).toBeNull();
    expect(store.getProjectLock(project.id)?.ownerToken).toBe('foreign');
    store.releaseProjectLock(project.id, 'foreign');
  });

  it('waits for a migration and reports the wait', async () => {
    const { store, project, service, scan, finding } = await setup(800);
    expect(store.tryAcquireProjectLock(project.id, process.pid, 'foreign').ok).toBe(true);

    const pending = service.execute(scan.id, [finding.id]);
    setTimeout(() => store.releaseProjectLock(project.id, 'foreign'), 150);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('Waited'))).toBe(true);
    expect(store.getProjectLock(project.id)).toBeNull();
  });

  it('times out a migration with a reason and writes nothing', async () => {
    const { file, store, project, service, scan, finding } = await setup(250);
    const before = readFileSync(file);
    expect(store.tryAcquireProjectLock(project.id, process.pid, 'foreign').ok).toBe(true);

    const result = await service.execute(scan.id, [finding.id]);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.failures[0]?.reason).toContain('Timed out after');
    expect(readFileSync(file).equals(before)).toBe(true);
    store.releaseProjectLock(project.id, 'foreign');
  });

  it('waits for a rollback and restores the file', async () => {
    const { file, store, project, service, scan, finding } = await setup(800);
    const before = readFileSync(file);
    const applied = await service.execute(scan.id, [finding.id]);
    expect(applied.ok).toBe(true);
    expect(readFileSync(file).equals(before)).toBe(false);

    expect(store.tryAcquireProjectLock(project.id, process.pid, 'foreign').ok).toBe(true);
    const pending = service.rollbackSession(applied.sessionId);
    setTimeout(() => store.releaseProjectLock(project.id, 'foreign'), 150);
    const rolledBack = await pending;
    expect(rolledBack.ok).toBe(true);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(store.getProjectLock(project.id)).toBeNull();
  });

  it('reclaims a queued scan whose waiting process is gone', async () => {
    const { store, config, project } = await setup(0);
    const scan = store.createScan(project, config, ruleSignature());
    store.updateScan(scan.id, {
      status: 'QUEUED',
      runnerPid: DEAD_PID,
      waitingFor: 'Another operation is already running on this project.',
    });

    new ScanManager(store, { lockWaitMs: 0 });
    const reclaimed = store.getScan(scan.id);
    expect(reclaimed?.status).toBe('FAILED');
    expect(reclaimed?.waitingFor).toBeNull();
    expect(reclaimed?.errorSummary).toContain('waiting for the project lock');
  });
});

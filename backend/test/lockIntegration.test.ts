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

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-lockint-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, SOURCE);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Lock integration', root, config);
  const manager = new ScanManager(store, { lockWaitMs: 0 });

  const scan: ScanTask = store.createScan(project, config, ruleSignature());
  manager.start(scan.id);
  await waitForScan(store, scan.id);
  await waitForUnlock(store, project.id);
  const finding = store.listAllFindings(scan.id).find((item) => item.ruleId === 'WL-JS-001');
  if (!finding) throw new Error('fixture finding missing');
  const service = new MigrationService(store, { lockWaitMs: 0 });
  return { file, store, config, project, manager, scan, finding, service };
}

describe('project lock integration', () => {
  it('fails a scan fast when another owner is live, and reclaims a dead owner', async () => {
    const { store, config, project, manager } = await setup();

    const foreign = store.tryAcquireProjectLock(project.id, process.pid, 'foreign');
    expect(foreign.ok).toBe(true);
    const blocked = store.createScan(project, config, ruleSignature());
    const started = manager.start(blocked.id);
    expect(started.ok).toBe(false);
    expect(store.getScan(blocked.id)?.status).toBe('FAILED');
    expect(store.getScan(blocked.id)?.errorSummary).toContain('Another operation is already running');
    expect(store.getProjectLock(project.id)?.ownerToken).toBe('foreign');

    store.releaseProjectLock(project.id, 'foreign');
    const next = store.createScan(project, config, ruleSignature());
    expect(manager.start(next.id).ok).toBe(true);
    await waitForScan(store, next.id);
    await waitForUnlock(store, project.id);
    expect(store.getScan(next.id)?.status).toBe('COMPLETED');

    expect(store.tryAcquireProjectLock(project.id, DEAD_PID, 'dead').ok).toBe(true);
    const afterDeath = store.createScan(project, config, ruleSignature());
    expect(manager.start(afterDeath.id).ok).toBe(true);
    await waitForScan(store, afterDeath.id);
    await waitForUnlock(store, project.id);
    expect(store.getScan(afterDeath.id)?.status).toBe('COMPLETED');
  });

  it('blocks migration and rollback while a foreign owner holds the project', async () => {
    const { file, store, project, scan, finding, service } = await setup();
    const before = readFileSync(file);

    expect(store.tryAcquireProjectLock(project.id, process.pid, 'foreign').ok).toBe(true);
    const blocked = await service.execute(scan.id, [finding.id]);
    expect(blocked.ok).toBe(false);
    expect(blocked.aborted).toBe(true);
    expect(blocked.failures[0]?.reason).toContain('Another operation is already running');
    expect(readFileSync(file).equals(before)).toBe(true);
    store.releaseProjectLock(project.id, 'foreign');

    const applied = await service.execute(scan.id, [finding.id]);
    expect(applied.ok).toBe(true);
    expect(store.getProjectLock(project.id)).toBeNull();

    expect(store.tryAcquireProjectLock(project.id, process.pid, 'foreign-2').ok).toBe(true);
    const rollbackBlocked = await service.rollbackSession(applied.sessionId);
    expect(rollbackBlocked.ok).toBe(false);
    expect(rollbackBlocked.reason).toContain('Another operation is already running');
    store.releaseProjectLock(project.id, 'foreign-2');

    const rolledBack = await service.rollbackSession(applied.sessionId);
    expect(rolledBack.ok).toBe(true);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(store.getProjectLock(project.id)).toBeNull();
  });
});

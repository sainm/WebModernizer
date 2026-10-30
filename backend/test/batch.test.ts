import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';
import type { ScanStatus } from '../src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '../../examples/legacy-app');
const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

async function waitForScan(store: Store, scanId: string, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const scan = store.getScan(scanId);
    if (scan && TERMINAL.includes(scan.status)) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('scan did not finish in time');
}

describe('batch-scoped migration', () => {
  let workDir: string;
  let projectCopy: string;
  let store: Store;
  let scanId: string;
  let service: MigrationService;
  const targetFile = 'js/legacy-events.js';

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'weblift-batch-'));
    projectCopy = join(workDir, 'legacy-app');
    cpSync(exampleRoot, projectCopy, { recursive: true });
    store = new Store({ dataDir: join(workDir, 'data') });
    const scans = new ScanManager(store);
    const project = store.createProject('Batch Test', projectCopy, defaultProjectConfig());
    const scan = store.createScan(project, defaultProjectConfig(), ruleSignature());
    scanId = scan.id;
    scans.start(scan.id);
    await waitForScan(store, scan.id);
    service = new MigrationService(store);
  }, 60000);

  afterAll(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('groups several findings of one file write into a single batch', async () => {
    const original = readFileSync(join(projectCopy, targetFile), 'utf8');
    const findings = store
      .listAllFindings(scanId)
      .filter(
        (finding) =>
          finding.filePath === targetFile && (finding.migrationLevel === 'SAFE' || finding.migrationLevel === 'CONDITIONAL'),
      )
      .slice(0, 2);

    expect(findings.length).toBe(2);

    const result = await service.execute(
      scanId,
      findings.map((finding) => finding.id),
    );
    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(2);

    const [first, second] = result.executions;
    expect(first.batchId).toBeTruthy();
    expect(first.batchId).toBe(second.batchId);
    expect(first.filePath).toBe(targetFile);

    const batchRows = store.listMigrationsByBatch(first.batchId as string);
    expect(batchRows).toHaveLength(2);

    // The file was written once, so both rows share the same before/after hashes.
    expect(new Set(batchRows.map((row) => row.afterHash)).size).toBe(1);
    expect(readFileSync(join(projectCopy, targetFile), 'utf8')).not.toBe(original);

    // A single-row rollback restores everything that execute() call wrote, which is the
    // whole session: one file write here, but the scope is the transaction.
    const rollback = service.rollback(first.id);
    expect(rollback.ok).toBe(true);
    expect(rollback.affectedFindings).toBe(2);
    expect(rollback.sessionId).toBe(first.sessionId);
    expect(rollback.batchId).toBeNull();
    expect(readFileSync(join(projectCopy, targetFile), 'utf8')).toBe(original);

    // Both findings go back to a migratable state, not just the one that was addressed.
    for (const execution of result.executions) {
      expect(store.getFinding(execution.findingId)?.status).toBe('READY_FOR_MIGRATION');
      expect(store.getMigration(execution.id)?.executionStatus).toBe('ROLLED_BACK');
    }
  });

  it('refuses to roll back the same batch twice', async () => {
    const applied = store.listMigrations(scanId).filter((row) => row.executionStatus === 'APPLIED');
    if (applied.length === 0) {
      const findings = store
        .listAllFindings(scanId)
        .filter((finding) => finding.filePath === targetFile && finding.migrationLevel === 'SAFE')
        .slice(0, 1);
      if (findings.length === 0) return;
      const result = await service.execute(scanId, [findings[0].id]);
      const batchId = result.executions[0].batchId as string;
      expect(service.rollbackBatch(batchId).ok).toBe(true);
      const again = service.rollbackBatch(batchId);
      expect(again.ok).toBe(false);
      expect(again.reason).toMatch(/Already rolled back/);
      return;
    }
    const batchId = applied[0].batchId as string;
    expect(service.rollbackBatch(batchId).ok).toBe(true);
    const again = service.rollbackBatch(batchId);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/Already rolled back/);
  });

  it('reports unknown batches instead of pretending success', async () => {
    const result = service.rollbackBatch('bat_does_not_exist');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Unknown batch');
  });
});

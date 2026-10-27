import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

const OLD_SCHEMA = `
CREATE TABLE migration_execution (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scan_task_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  diff TEXT NOT NULL,
  execution_status TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  rolled_back_at TEXT,
  backup_path TEXT NOT NULL,
  note TEXT
);
`;

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-upgrade-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('storage upgrade path', () => {
  it('adds the batch_id column to a database created before batches existed', () => {
    const dataDir = tempDir();
    mkdirSync(dataDir, { recursive: true });

    // Simulate a data directory written by the previous release.
    const legacy = new DatabaseSync(join(dataDir, 'weblift.sqlite'));
    legacy.exec(OLD_SCHEMA);
    legacy
      .prepare(
        `INSERT INTO migration_execution (id, project_id, scan_task_id, rule_id, finding_id, file_path, before_hash,
          after_hash, diff, execution_status, validation_status, executed_at, rolled_back_at, backup_path, note)
         VALUES ('exe_old', 'prj_1', 'scn_1', 'WL-JS-001', 'fnd_1', 'js/a.js', 'h1', 'h2', '', 'APPLIED', 'PENDING',
           '2026-01-01T00:00:00.000Z', NULL, '/tmp/backup.js', 'legacy row')`,
      )
      .run();
    legacy.close();

    // Opening the store must migrate in place instead of throwing on a missing column.
    const store = new Store({ dataDir });
    try {
      const migration = store.getMigration('exe_old');
      expect(migration).not.toBeNull();
      expect(migration?.batchId).toBeNull();
      expect(migration?.ruleId).toBe('WL-JS-001');

      // Rows written after the upgrade carry a batch id.
      store.insertMigration({
        id: 'exe_new',
        projectId: 'prj_1',
        scanTaskId: 'scn_1',
        ruleId: 'WL-JS-006',
        findingId: 'fnd_2',
        filePath: 'js/b.js',
        beforeHash: 'h3',
        afterHash: 'h4',
        diff: '',
        executionStatus: 'APPLIED',
        validationStatus: 'PENDING',
        executedAt: '2026-01-02T00:00:00.000Z',
        rolledBackAt: null,
        backupPath: '/tmp/backup2.js',
        note: null,
        batchId: 'bat_1',
        sessionId: 'ses_1',
      });
      expect(store.listMigrationsByBatch('bat_1')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('is idempotent when the data directory is already current', () => {
    const dataDir = tempDir();
    const first = new Store({ dataDir });
    first.close();
    const second = new Store({ dataDir });
    try {
      expect(second.listMigrations()).toHaveLength(0);
    } finally {
      second.close();
    }
  });
});

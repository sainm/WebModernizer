import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type {
  AnalysisFinding,
  RelationConfidence,
  BrowserValidationResult,
  Category,
  Confidence,
  ExecutionStatus,
  FileReference,
  FindingStatus,
  Language,
  MigrationExecution,
  MigrationLevel,
  ParseProblem,
  Project,
  ProjectConfig,
  ScanPhase,
  ScanStatus,
  ScanTask,
  Severity,
  ValidationStatus,
  VisualBaseline,
  IgnoreRule,
} from '../model/types.js';
import { newId, nowIso } from '../model/ids.js';

export interface ScanFileRow {
  id: string;
  scanTaskId: string;
  path: string;
  language: Language;
  size: number;
  hash: string;
  encoding: string;
  parseStatus: 'PARSED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  findingCount: number;
  /** True when this file was unchanged and its findings came from the previous scan. */
  reused: boolean;
}

export interface FindingQuery {
  category?: Category;
  severity?: Severity;
  migrationLevel?: MigrationLevel;
  status?: FindingStatus;
  ruleId?: string;
  language?: Language;
  pathContains?: string;
  modulePath?: string;
  q?: string;
  sort?: 'risk' | 'path' | 'type' | 'priority';
  limit?: number;
  offset?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  scanned_file_count INTEGER NOT NULL DEFAULT 0,
  parsed_file_count INTEGER NOT NULL DEFAULT 0,
  failed_file_count INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  current_file TEXT,
  error_summary TEXT,
  config_snapshot TEXT NOT NULL,
  rule_signature TEXT,
  log_json TEXT NOT NULL DEFAULT '[]',
  cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scan_project ON scan_task(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scan_file (
  id TEXT PRIMARY KEY,
  scan_task_id TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'utf-8',
  parse_status TEXT NOT NULL,
  problem_count INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  reused INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scanfile_task ON scan_file(scan_task_id);
CREATE INDEX IF NOT EXISTS idx_scanfile_path ON scan_file(scan_task_id, path);

CREATE TABLE IF NOT EXISTS finding (
  id TEXT PRIMARY KEY,
  scan_task_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  migration_level TEXT NOT NULL,
  confidence TEXT NOT NULL,
  message TEXT NOT NULL,
  message_key TEXT NOT NULL DEFAULT '',
  message_params TEXT NOT NULL DEFAULT '{}',
  risk TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  snippet TEXT NOT NULL,
  status TEXT NOT NULL,
  status_updated_at TEXT NOT NULL,
  status_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_finding_task ON finding(scan_task_id, severity, start_line);
CREATE INDEX IF NOT EXISTS idx_finding_rule ON finding(scan_task_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_finding_file ON finding(scan_task_id, file_path, start_offset);

CREATE TABLE IF NOT EXISTS finding_status_history (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  rule_id TEXT,
  note TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_finding ON finding_status_history(finding_id, at);

CREATE TABLE IF NOT EXISTS file_relation (
  id TEXT PRIMARY KEY,
  scan_task_id TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  evidence TEXT NOT NULL,
  line INTEGER
);
CREATE INDEX IF NOT EXISTS idx_relation_task ON file_relation(scan_task_id);

CREATE TABLE IF NOT EXISTS parse_problem (
  id TEXT PRIMARY KEY,
  scan_task_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  line INTEGER,
  column INTEGER,
  recovered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_problem_task ON parse_problem(scan_task_id);

CREATE TABLE IF NOT EXISTS migration_execution (
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
  note TEXT,
  batch_id TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_migration_task ON migration_execution(scan_task_id, executed_at DESC);
-- idx_migration_session is created in migrate(): an upgraded database lacks the
-- session_id column until the ALTER runs, exactly like batch_id before it.
-- idx_migration_batch is created in migrate(): an upgraded database does not have the
-- batch_id column until the ALTER below runs, so it cannot be created here.

CREATE TABLE IF NOT EXISTS rule_state (
  rule_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ignore_rule (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  rule_id TEXT,
  path_pattern TEXT,
  reason TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ignore_project ON ignore_rule(project_id, created_at);

CREATE TABLE IF NOT EXISTS visual_baseline (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_visual_key ON visual_baseline(project_id, page_key);

CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY,
  scan_task_id TEXT NOT NULL,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS validation_run (
  id TEXT PRIMARY KEY,
  scan_task_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  passed INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  executed_at TEXT NOT NULL
);
`;

/**
 * node:sqlite is loaded through createRequire instead of a static import: bundlers
 * and test transforms (Vite/Vitest) do not treat it as a known builtin yet and would
 * otherwise fail to resolve it.
 */
type SqliteModule = typeof import('node:sqlite');
const nodeRequire = createRequire(import.meta.url);
let sqliteModule: SqliteModule | null = null;

function loadSqlite(): SqliteModule {
  if (!sqliteModule) {
    sqliteModule = nodeRequire('node:sqlite') as SqliteModule;
  }
  return sqliteModule;
}

export interface StoreOptions {
  dataDir?: string;
}

export class Store {
  readonly db: InstanceType<SqliteModule['DatabaseSync']>;

  constructor(options: StoreOptions = {}) {
    const dataDir = options.dataDir ?? process.env.WEBLIFT_DATA_DIR ?? resolve(process.cwd(), 'data');
    const file = join(dataDir, 'weblift.sqlite');
    mkdirSync(dirname(file), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * SQLite has no ADD COLUMN IF NOT EXISTS, so column additions are applied by
   * inspecting the current table shape. Keeping this idempotent means an existing
   * data directory keeps working across upgrades instead of needing a reset.
   */
  private migrate(): void {
    const columns = (this.db.prepare('PRAGMA table_info(migration_execution)').all() as unknown as Array<{ name: string }>).map(
      (row) => row.name,
    );
    if (!columns.includes('batch_id')) {
      this.db.exec('ALTER TABLE migration_execution ADD COLUMN batch_id TEXT');
    }
    if (!columns.includes('session_id')) {
      this.db.exec('ALTER TABLE migration_execution ADD COLUMN session_id TEXT');
    }
    // Safe for both paths: a fresh database already has the column, an upgraded one
    // just got it above.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_migration_batch ON migration_execution(batch_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_migration_session ON migration_execution(session_id)');

    const scanColumns = (this.db.prepare('PRAGMA table_info(scan_task)').all() as unknown as Array<{ name: string }>).map(
      (row) => row.name,
    );
    if (!scanColumns.includes('rule_signature')) {
      this.db.exec('ALTER TABLE scan_task ADD COLUMN rule_signature TEXT');
    }
    const fileColumns = (this.db.prepare('PRAGMA table_info(scan_file)').all() as unknown as Array<{ name: string }>).map(
      (row) => row.name,
    );
    if (!fileColumns.includes('reused')) {
      this.db.exec('ALTER TABLE scan_file ADD COLUMN reused INTEGER NOT NULL DEFAULT 0');
    }

    const findingColumns = (this.db.prepare('PRAGMA table_info(finding)').all() as unknown as Array<{ name: string }>).map(
      (row) => row.name,
    );
    if (!findingColumns.includes('message_key')) {
      this.db.exec("ALTER TABLE finding ADD COLUMN message_key TEXT NOT NULL DEFAULT ''");
    }
    if (!findingColumns.includes('message_params')) {
      this.db.exec("ALTER TABLE finding ADD COLUMN message_params TEXT NOT NULL DEFAULT '{}'");
    }
  }

  close(): void {
    this.db.close();
  }

  /* ----------------------------- projects ----------------------------- */

  createProject(name: string, rootPath: string, config: ProjectConfig): Project {
    const project: Project = {
      id: newId('prj'),
      name,
      rootPath,
      config,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .prepare('INSERT INTO project (id, name, root_path, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.rootPath, JSON.stringify(config), project.createdAt, project.updatedAt);
    return project;
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM project ORDER BY created_at DESC').all() as unknown as ProjectRow[];
    return rows.map(mapProject);
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM project WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'rootPath' | 'config'>>): Project | null {
    const existing = this.getProject(id);
    if (!existing) return null;
    const next: Project = {
      ...existing,
      name: patch.name ?? existing.name,
      rootPath: patch.rootPath ?? existing.rootPath,
      config: patch.config ?? existing.config,
      updatedAt: nowIso(),
    };
    this.db
      .prepare('UPDATE project SET name = ?, root_path = ?, config_json = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.rootPath, JSON.stringify(next.config), next.updatedAt, id);
    return next;
  }

  deleteProject(id: string): boolean {
    const result = this.db.prepare('DELETE FROM project WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /* ----------------------------- scans ----------------------------- */

  createScan(project: Project, config: ProjectConfig, ruleSignature: string | null = null): ScanTask {
    const task: ScanTask = {
      id: newId('scn'),
      projectId: project.id,
      projectName: project.name,
      rootPath: project.rootPath,
      status: 'QUEUED',
      phase: null,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      scannedFileCount: 0,
      parsedFileCount: 0,
      failedFileCount: 0,
      findingCount: 0,
      currentFile: null,
      errorSummary: null,
      configSnapshot: config,
      ruleSignature,
    };
    this.db
      .prepare(
        `INSERT INTO scan_task (id, project_id, project_name, root_path, status, phase, created_at, config_snapshot, rule_signature, log_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
      )
      .run(task.id, task.projectId, task.projectName, task.rootPath, task.status, null, task.createdAt, JSON.stringify(config), ruleSignature);
    return task;
  }

  updateScan(
    id: string,
    patch: Partial<
      Pick<
        ScanTask,
        | 'status'
        | 'phase'
        | 'startedAt'
        | 'completedAt'
        | 'scannedFileCount'
        | 'parsedFileCount'
        | 'failedFileCount'
        | 'findingCount'
        | 'currentFile'
        | 'errorSummary'
      >
    > & { cancelled?: boolean; logJson?: string },
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const map: Record<string, string> = {
      status: 'status',
      phase: 'phase',
      startedAt: 'started_at',
      completedAt: 'completed_at',
      scannedFileCount: 'scanned_file_count',
      parsedFileCount: 'parsed_file_count',
      failedFileCount: 'failed_file_count',
      findingCount: 'finding_count',
      currentFile: 'current_file',
      errorSummary: 'error_summary',
      cancelled: 'cancelled',
      logJson: 'log_json',
    };
    for (const [key, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null));
    }
    if (!sets.length) return;
    values.push(id);
    this.db.prepare(`UPDATE scan_task SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getScan(id: string): ScanTask | null {
    const row = this.db.prepare('SELECT * FROM scan_task WHERE id = ?').get(id) as ScanRow | undefined;
    return row ? mapScan(row) : null;
  }

  listScans(projectId?: string, limit = 100): ScanTask[] {
    const rows = projectId
      ? (this.db.prepare('SELECT * FROM scan_task WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as unknown as ScanRow[])
      : (this.db.prepare('SELECT * FROM scan_task ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ScanRow[]);
    return rows.map(mapScan);
  }

  getScanLog(id: string): Array<{ at: string; level: string; phase: string | null; message: string }> {
    const row = this.db.prepare('SELECT log_json FROM scan_task WHERE id = ?').get(id) as unknown as { log_json: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.log_json) as Array<{ at: string; level: string; phase: string | null; message: string }>;
    } catch {
      return [];
    }
  }

  /* ----------------------------- scan files ----------------------------- */

  insertScanFiles(rows: ScanFileRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO scan_file (id, scan_task_id, path, language, size, hash, encoding, parse_status, finding_count, reused)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        stmt.run(
          row.id,
          row.scanTaskId,
          row.path,
          row.language,
          row.size,
          row.hash,
          row.encoding,
          row.parseStatus,
          row.findingCount,
          row.reused ? 1 : 0,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listScanFiles(scanTaskId: string, limit = 5000): ScanFileRow[] {
    const rows = this.db
      .prepare('SELECT * FROM scan_file WHERE scan_task_id = ? ORDER BY path LIMIT ?')
      .all(scanTaskId, limit) as unknown as ScanFileRowRaw[];
    return rows.map((row) => ({
      id: row.id,
      scanTaskId: row.scan_task_id,
      path: row.path,
      language: row.language as Language,
      size: row.size,
      hash: row.hash,
      encoding: row.encoding,
      parseStatus: row.parse_status as ScanFileRow['parseStatus'],
      findingCount: row.finding_count,
      reused: row.reused === 1,
    }));
  }

  getScanFile(scanTaskId: string, path: string): ScanFileRow | null {
    const row = this.db
      .prepare('SELECT * FROM scan_file WHERE scan_task_id = ? AND path = ?')
      .get(scanTaskId, path) as ScanFileRowRaw | undefined;
    if (!row) return null;
    return {
      id: row.id,
      scanTaskId: row.scan_task_id,
      path: row.path,
      language: row.language as Language,
      size: row.size,
      hash: row.hash,
      encoding: row.encoding,
      parseStatus: row.parse_status as ScanFileRow['parseStatus'],
      findingCount: row.finding_count,
      reused: row.reused === 1,
    };
  }

  /* ----------------------------- findings ----------------------------- */

  insertFindings(findings: AnalysisFinding[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO finding (id, scan_task_id, rule_id, rule_version, file_path, language, start_line, end_line,
        start_column, end_column, start_offset, end_offset, category, severity, migration_level, confidence,
        message, message_key, message_params, risk, recommendation, evidence_json, snippet, status, status_updated_at, status_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const f of findings) {
        stmt.run(
          f.id,
          f.scanTaskId,
          f.ruleId,
          f.ruleVersion,
          f.filePath,
          f.language,
          f.startLine,
          f.endLine,
          f.startColumn,
          f.endColumn,
          f.startOffset,
          f.endOffset,
          f.category,
          f.severity,
          f.migrationLevel,
          f.confidence,
          f.message,
          f.messageKey,
          JSON.stringify(f.messageParams ?? {}),
          f.risk,
          f.recommendation,
          JSON.stringify(f.evidence),
          f.snippet,
          f.status,
          f.statusUpdatedAt,
          f.statusNote ?? null,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getFinding(id: string): AnalysisFinding | null {
    const row = this.db.prepare('SELECT * FROM finding WHERE id = ?').get(id) as FindingRow | undefined;
    return row ? mapFinding(row) : null;
  }

  listFindings(scanTaskId: string, query: FindingQuery = {}): { total: number; items: AnalysisFinding[] } {
    const where: string[] = ['scan_task_id = ?'];
    const params: Array<string | number> = [scanTaskId];

    if (query.category) {
      where.push('category = ?');
      params.push(query.category);
    }
    if (query.severity) {
      where.push('severity = ?');
      params.push(query.severity);
    }
    if (query.migrationLevel) {
      where.push('migration_level = ?');
      params.push(query.migrationLevel);
    }
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.ruleId) {
      where.push('rule_id = ?');
      params.push(query.ruleId);
    }
    if (query.language) {
      where.push('language = ?');
      params.push(query.language);
    }
    if (query.pathContains) {
      where.push('file_path LIKE ?');
      params.push(`%${query.pathContains}%`);
    }
    if (query.modulePath) {
      where.push('(file_path = ? OR file_path LIKE ?)');
      params.push(query.modulePath, `${query.modulePath.replace(/\/$/, '')}%`);
    }
    if (query.q) {
      where.push('(message LIKE ? OR snippet LIKE ? OR file_path LIKE ? OR rule_id LIKE ?)');
      const like = `%${query.q}%`;
      params.push(like, like, like, like);
    }

    const clause = where.join(' AND ');
    const sortMap: Record<string, string> = {
      risk: `CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END, file_path, start_offset`,
      path: 'file_path, start_offset',
      type: 'category, rule_id, file_path',
      priority: `CASE migration_level WHEN 'SAFE' THEN 0 WHEN 'CONDITIONAL' THEN 1 WHEN 'MANUAL' THEN 2 ELSE 3 END, file_path`,
    };
    const order = sortMap[query.sort ?? 'risk'] ?? sortMap.risk;

    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM finding WHERE ${clause}`).get(...params) as unknown as { c: number };
    const limit = Math.min(query.limit ?? 200, 2000);
    const offset = Math.max(0, query.offset ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM finding WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as FindingRow[];

    return { total: totalRow.c, items: rows.map(mapFinding) };
  }

  /** Findings of a single file; used to carry results over on incremental scans. */
  listFindingsForFile(scanTaskId: string, filePath: string): AnalysisFinding[] {
    const rows = this.db
      .prepare('SELECT * FROM finding WHERE scan_task_id = ? AND file_path = ? ORDER BY start_offset')
      .all(scanTaskId, filePath) as unknown as FindingRow[];
    return rows.map(mapFinding);
  }

  listAllFindings(scanTaskId: string): AnalysisFinding[] {
    const rows = this.db
      .prepare('SELECT * FROM finding WHERE scan_task_id = ? ORDER BY file_path, start_offset')
      .all(scanTaskId) as unknown as FindingRow[];
    return rows.map(mapFinding);
  }

  updateFindingStatus(id: string, status: FindingStatus, actor: string, note: string | null): AnalysisFinding | null {
    const existing = this.getFinding(id);
    if (!existing) return null;
    const at = nowIso();
    this.db.prepare('UPDATE finding SET status = ?, status_updated_at = ?, status_note = ? WHERE id = ?').run(status, at, note, id);
    this.db
      .prepare(
        'INSERT INTO finding_status_history (id, finding_id, from_status, to_status, actor, rule_id, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(newId('hst'), id, existing.status, status, actor, existing.ruleId, note, at);
    return this.getFinding(id);
  }

  getFindingHistory(id: string): Array<{ id: string; fromStatus: string | null; toStatus: string; actor: string; note: string | null; at: string }> {
    const rows = this.db
      .prepare('SELECT * FROM finding_status_history WHERE finding_id = ? ORDER BY at ASC')
      .all(id) as Array<{ id: string; from_status: string | null; to_status: string; actor: string; note: string | null; at: string }>;
    return rows.map((row) => ({
      id: row.id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actor: row.actor,
      note: row.note,
      at: row.at,
    }));
  }

  /* ----------------------------- relations ----------------------------- */

  insertRelations(scanTaskId: string, relations: FileReference[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO file_relation (id, scan_task_id, from_path, to_path, kind, confidence, evidence, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const rel of relations) {
        stmt.run(newId('rel'), scanTaskId, rel.fromPath, rel.toPath, rel.kind, rel.confidence, rel.evidence, rel.line ?? null);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listRelations(scanTaskId: string): FileReference[] {
    const rows = this.db
      .prepare('SELECT * FROM file_relation WHERE scan_task_id = ? ORDER BY from_path, to_path')
      .all(scanTaskId) as Array<{
      from_path: string;
      to_path: string;
      kind: FileReference['kind'];
      confidence: RelationConfidence;
      evidence: string;
      line: number | null;
    }>;
    return rows.map((row) => ({
      fromPath: row.from_path,
      toPath: row.to_path,
      kind: row.kind,
      confidence: row.confidence,
      evidence: row.evidence,
      line: row.line ?? undefined,
    }));
  }

  /* ----------------------------- parse problems ----------------------------- */

  insertParseProblems(scanTaskId: string, problems: ParseProblem[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO parse_problem (id, scan_task_id, file_path, phase, message, line, column, recovered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const p of problems) {
        stmt.run(newId('prb'), scanTaskId, p.filePath, p.phase, p.message, p.line ?? null, p.column ?? null, p.recovered ? 1 : 0);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listParseProblems(scanTaskId: string): ParseProblem[] {
    const rows = this.db
      .prepare('SELECT * FROM parse_problem WHERE scan_task_id = ? ORDER BY file_path LIMIT 2000')
      .all(scanTaskId) as Array<{
      file_path: string;
      phase: ParseProblem['phase'];
      message: string;
      line: number | null;
      column: number | null;
      recovered: number;
    }>;
    return rows.map((row) => ({
      filePath: row.file_path,
      phase: row.phase,
      message: row.message,
      line: row.line ?? undefined,
      column: row.column ?? undefined,
      recovered: row.recovered === 1,
    }));
  }

  /* ----------------------------- migrations ----------------------------- */

  insertMigration(execution: MigrationExecution): void {
    this.db
      .prepare(
        `INSERT INTO migration_execution (id, project_id, scan_task_id, rule_id, finding_id, file_path, before_hash, after_hash,
          diff, execution_status, validation_status, executed_at, rolled_back_at, backup_path, note, batch_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.id,
        execution.projectId,
        execution.scanTaskId,
        execution.ruleId,
        execution.findingId,
        execution.filePath,
        execution.beforeHash,
        execution.afterHash,
        execution.diff,
        execution.executionStatus,
        execution.validationStatus,
        execution.executedAt,
        execution.rolledBackAt,
        execution.backupPath,
        execution.note,
        execution.batchId ?? null,
        execution.sessionId ?? null,
      );
  }

  updateMigration(id: string, patch: { executionStatus?: ExecutionStatus; validationStatus?: ValidationStatus; rolledBackAt?: string | null }): void {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (patch.executionStatus) {
      sets.push('execution_status = ?');
      values.push(patch.executionStatus);
    }
    if (patch.validationStatus) {
      sets.push('validation_status = ?');
      values.push(patch.validationStatus);
    }
    if (patch.rolledBackAt !== undefined) {
      sets.push('rolled_back_at = ?');
      values.push(patch.rolledBackAt);
    }
    if (!sets.length) return;
    values.push(id);
    this.db.prepare(`UPDATE migration_execution SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Every execution produced by one execute() call, across all files. */
  listMigrationsBySession(sessionId: string): MigrationExecution[] {
    const rows = this.db
      .prepare('SELECT * FROM migration_execution WHERE session_id = ? ORDER BY file_path ASC, executed_at ASC')
      .all(sessionId) as unknown as MigrationRow[];
    return rows.map(mapMigration);
  }

  /** All executions written by one atomic file write, newest first. */
  listMigrationsByBatch(batchId: string): MigrationExecution[] {
    const rows = this.db
      .prepare('SELECT * FROM migration_execution WHERE batch_id = ? ORDER BY executed_at ASC')
      .all(batchId) as unknown as MigrationRow[];
    return rows.map(mapMigration);
  }

  getMigration(id: string): MigrationExecution | null {
    const row = this.db.prepare('SELECT * FROM migration_execution WHERE id = ?').get(id) as MigrationRow | undefined;
    return row ? mapMigration(row) : null;
  }

  listMigrations(scanTaskId?: string, limit = 200): MigrationExecution[] {
    const rows = scanTaskId
      ? (this.db.prepare('SELECT * FROM migration_execution WHERE scan_task_id = ? ORDER BY executed_at DESC LIMIT ?').all(scanTaskId, limit) as unknown as MigrationRow[])
      : (this.db.prepare('SELECT * FROM migration_execution ORDER BY executed_at DESC LIMIT ?').all(limit) as unknown as MigrationRow[]);
    return rows.map(mapMigration);
  }

  /* ----------------------------- rule state ----------------------------- */

  listRuleStates(): Map<string, boolean> {
    const rows = this.db.prepare('SELECT * FROM rule_state').all() as Array<{ rule_id: string; enabled: number }>;
    return new Map(rows.map((row) => [row.rule_id, row.enabled === 1]));
  }

  setRuleEnabled(ruleId: string, enabled: boolean): void {
    this.db
      .prepare(
        'INSERT INTO rule_state (rule_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(rule_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at',
      )
      .run(ruleId, enabled ? 1 : 0, nowIso());
  }

  /* ----------------------------- reports & validation ----------------------------- */

  insertReport(scanTaskId: string, format: string, path: string): { id: string; createdAt: string } {
    const id = newId('rpt');
    const createdAt = nowIso();
    this.db.prepare('INSERT INTO report (id, scan_task_id, format, path, created_at) VALUES (?, ?, ?, ?, ?)').run(id, scanTaskId, format, path, createdAt);
    return { id, createdAt };
  }

  listReports(scanTaskId?: string): Array<{ id: string; scanTaskId: string; format: string; path: string; createdAt: string }> {
    const rows = scanTaskId
      ? (this.db.prepare('SELECT * FROM report WHERE scan_task_id = ? ORDER BY created_at DESC').all(scanTaskId) as unknown as ReportRow[])
      : (this.db.prepare('SELECT * FROM report ORDER BY created_at DESC LIMIT 200').all() as unknown as ReportRow[]);
    return rows.map((row) => ({
      id: row.id,
      scanTaskId: row.scan_task_id,
      format: row.format,
      path: row.path,
      createdAt: row.created_at,
    }));
  }

  listIgnoreRules(projectId: string): IgnoreRule[] {
    const rows = this.db
      .prepare('SELECT * FROM ignore_rule WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as unknown as IgnoreRuleRow[];
    return rows.map(mapIgnoreRule);
  }

  createIgnoreRule(input: Omit<IgnoreRule, 'id' | 'createdAt'>): IgnoreRule {
    const rule: IgnoreRule = { ...input, id: newId('ign'), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO ignore_rule (id, project_id, rule_id, path_pattern, reason, enabled, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rule.id, rule.projectId, rule.ruleId, rule.pathPattern, rule.reason, rule.enabled ? 1 : 0, rule.createdBy, rule.createdAt);
    return rule;
  }

  setIgnoreRuleEnabled(id: string, enabled: boolean): boolean {
    const result = this.db.prepare('UPDATE ignore_rule SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  deleteIgnoreRule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM ignore_rule WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  getVisualBaseline(projectId: string, pageKey: string): VisualBaseline | null {
    const row = this.db
      .prepare('SELECT * FROM visual_baseline WHERE project_id = ? AND page_key = ?')
      .get(projectId, pageKey) as unknown as VisualBaselineRow | undefined;
    return row ? mapVisualBaseline(row) : null;
  }

  listVisualBaselines(projectId: string): VisualBaseline[] {
    const rows = this.db
      .prepare('SELECT * FROM visual_baseline WHERE project_id = ? ORDER BY page_key')
      .all(projectId) as unknown as VisualBaselineRow[];
    return rows.map(mapVisualBaseline);
  }

  upsertVisualBaseline(input: Omit<VisualBaseline, 'id' | 'createdAt'>): VisualBaseline {
    const existing = this.getVisualBaseline(input.projectId, input.pageKey);
    const id = existing?.id ?? newId('vis');
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO visual_baseline (id, project_id, page_key, url, path, width, height, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, page_key) DO UPDATE SET
           url = excluded.url, path = excluded.path, width = excluded.width, height = excluded.height,
           hash = excluded.hash, created_at = excluded.created_at`,
      )
      .run(id, input.projectId, input.pageKey, input.url, input.path, input.width, input.height, input.hash, createdAt);
    return { ...input, id, createdAt: existing ? createdAt : createdAt };
  }

  listValidationRuns(scanTaskId: string): Array<{ id: string; scope: string; passed: boolean; executedAt: string; payload: Record<string, unknown> }> {
    const rows = this.db
      .prepare('SELECT * FROM validation_run WHERE scan_task_id = ? ORDER BY executed_at DESC LIMIT 200')
      .all(scanTaskId) as unknown as Array<{ id: string; scope: string; passed: number; executed_at: string; payload_json: string }>;
    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      return { id: row.id, scope: row.scope, passed: row.passed === 1, executedAt: row.executed_at, payload };
    });
  }

  insertValidationRun(scanTaskId: string, scope: string, passed: boolean, payload: Record<string, unknown>): string {
    const id = newId('val');
    this.db
      .prepare('INSERT INTO validation_run (id, scan_task_id, scope, passed, payload_json, executed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, scanTaskId, scope, passed ? 1 : 0, JSON.stringify(payload), nowIso());
    return id;
  }
}

/* ----------------------------- row mappers ----------------------------- */

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface ScanRow {
  id: string;
  project_id: string;
  project_name: string;
  root_path: string;
  status: ScanStatus;
  phase: ScanPhase | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  scanned_file_count: number;
  parsed_file_count: number;
  failed_file_count: number;
  finding_count: number;
  current_file: string | null;
  error_summary: string | null;
  config_snapshot: string;
  rule_signature: string | null;
}

interface ScanFileRowRaw {
  id: string;
  scan_task_id: string;
  path: string;
  language: string;
  size: number;
  hash: string;
  encoding: string;
  parse_status: string;
  problem_count: number;
  finding_count: number;
  reused: number;
}

interface FindingRow {
  id: string;
  scan_task_id: string;
  rule_id: string;
  rule_version: string;
  file_path: string;
  language: Language;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  start_offset: number;
  end_offset: number;
  category: Category;
  severity: Severity;
  migration_level: MigrationLevel;
  confidence: Confidence;
  message: string;
  message_key: string;
  message_params: string;
  risk: string;
  recommendation: string;
  evidence_json: string;
  snippet: string;
  status: FindingStatus;
  status_updated_at: string;
  status_note: string | null;
}

interface MigrationRow {
  id: string;
  project_id: string;
  scan_task_id: string;
  rule_id: string;
  finding_id: string;
  file_path: string;
  before_hash: string;
  after_hash: string;
  diff: string;
  execution_status: ExecutionStatus;
  validation_status: ValidationStatus;
  executed_at: string;
  rolled_back_at: string | null;
  backup_path: string;
  note: string | null;
  batch_id: string | null;
  session_id: string | null;
}

interface IgnoreRuleRow {
  id: string;
  project_id: string;
  rule_id: string | null;
  path_pattern: string | null;
  reason: string;
  enabled: number;
  created_by: string;
  created_at: string;
}

interface VisualBaselineRow {
  id: string;
  project_id: string;
  page_key: string;
  url: string;
  path: string;
  width: number;
  height: number;
  hash: string;
  created_at: string;
}

interface ReportRow {
  id: string;
  scan_task_id: string;
  format: string;
  path: string;
  created_at: string;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    config: JSON.parse(row.config_json) as ProjectConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapScan(row: ScanRow): ScanTask {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    rootPath: row.root_path,
    status: row.status,
    phase: row.phase,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    scannedFileCount: row.scanned_file_count,
    parsedFileCount: row.parsed_file_count,
    failedFileCount: row.failed_file_count,
    findingCount: row.finding_count,
    currentFile: row.current_file,
    errorSummary: row.error_summary,
    configSnapshot: JSON.parse(row.config_snapshot) as ProjectConfig,
    ruleSignature: row.rule_signature ?? null,
  };
}

function mapFinding(row: FindingRow): AnalysisFinding {
  return {
    id: row.id,
    scanTaskId: row.scan_task_id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    filePath: row.file_path,
    language: row.language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    category: row.category,
    severity: row.severity,
    migrationLevel: row.migration_level,
    confidence: row.confidence,
    message: row.message,
    messageKey: row.message_key ?? '',
    messageParams: (() => {
      try {
        return JSON.parse(row.message_params ?? '{}') as Record<string, string | number>;
      } catch {
        return {};
      }
    })(),
    risk: row.risk,
    recommendation: row.recommendation,
    evidence: JSON.parse(row.evidence_json) as AnalysisFinding['evidence'],
    snippet: row.snippet,
    status: row.status,
    statusUpdatedAt: row.status_updated_at,
    statusNote: row.status_note ?? undefined,
  };
}

function mapIgnoreRule(row: IgnoreRuleRow): IgnoreRule {
  return {
    id: row.id,
    projectId: row.project_id,
    ruleId: row.rule_id ?? null,
    pathPattern: row.path_pattern ?? null,
    reason: row.reason,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapVisualBaseline(row: VisualBaselineRow): VisualBaseline {
  return {
    id: row.id,
    projectId: row.project_id,
    pageKey: row.page_key,
    url: row.url,
    path: row.path,
    width: row.width,
    height: row.height,
    hash: row.hash,
    createdAt: row.created_at,
  };
}

function mapMigration(row: MigrationRow): MigrationExecution {
  return {
    id: row.id,
    projectId: row.project_id,
    scanTaskId: row.scan_task_id,
    ruleId: row.rule_id,
    findingId: row.finding_id,
    filePath: row.file_path,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    diff: row.diff,
    executionStatus: row.execution_status,
    validationStatus: row.validation_status,
    executedAt: row.executed_at,
    rolledBackAt: row.rolled_back_at,
    backupPath: row.backup_path,
    note: row.note,
    batchId: row.batch_id ?? null,
    sessionId: row.session_id ?? null,
  };
}

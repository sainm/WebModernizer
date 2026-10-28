/** Typed client for the WebLift API. No mock data lives here: every call hits the backend. */

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type MigrationLevel = 'SAFE' | 'CONDITIONAL' | 'MANUAL' | 'UNSUPPORTED';
export type Confidence = 'CONFIRMED' | 'POSSIBLE' | 'NEEDS_ANALYSIS';
export type FindingStatus =
  | 'DETECTED'
  | 'READY_FOR_MIGRATION'
  | 'MIGRATED'
  | 'REVIEW_REQUIRED'
  | 'VALIDATED'
  | 'VALIDATION_FAILED'
  | 'IGNORED';
export type ScanStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'FAILED' | 'CANCELLED';
export type Category =
  | 'JS_API'
  | 'DOM_API'
  | 'HTML_COMPAT'
  | 'CSS_COMPAT'
  | 'ACTIVEX_VBSCRIPT'
  | 'BROWSER_BEHAVIOR'
  | 'DYNAMIC_CODE';
export type ScanPhase =
  | 'FILE_DISCOVERY'
  | 'FILE_CLASSIFICATION'
  | 'PARSING'
  | 'IE_DETECTION'
  | 'REFERENCE_ANALYSIS'
  | 'FINDING_MERGE'
  | 'PERSISTENCE'
  | 'REPORT_GENERATION';

export interface ProjectModule {
  name: string;
  path: string;
}

export interface ProjectConfig {
  includeExtensions: string[];
  excludeDirs: string[];
  excludeGlobs: string[];
  maxFileSizeBytes: number;
  maxDepth: number;
  encodingCandidates: string[];
  forceEncoding?: string;
  modules: ProjectModule[];
}

export interface ScanTask {
  id: string;
  projectId: string;
  projectName: string;
  rootPath: string;
  status: ScanStatus;
  phase: ScanPhase | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  scannedFileCount: number;
  parsedFileCount: number;
  failedFileCount: number;
  findingCount: number;
  currentFile: string | null;
  errorSummary: string | null;
  configSnapshot: ProjectConfig;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  config: ProjectConfig;
  createdAt: string;
  updatedAt: string;
  lastScan?: ScanTask | null;
  scans?: ScanTask[];
}

export interface Evidence {
  kind: string;
  matched: string;
  detail: Record<string, string | number | boolean | null>;
  touchesDynamicRegion?: boolean;
  container?: string;
}

export interface Finding {
  id: string;
  scanTaskId: string;
  ruleId: string;
  ruleVersion: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
  category: Category;
  severity: Severity;
  migrationLevel: MigrationLevel;
  confidence: Confidence;
  message: string;
  messageKey: string;
  messageParams: Record<string, string | number>;
  risk: string;
  evidence: Evidence;
  recommendation: string;
  snippet: string;
  status: FindingStatus;
  statusUpdatedAt: string;
  statusNote?: string;
  /** A mechanical rewrite exists in principle, but no recipe ships in this build. */
  automationCandidate?: boolean;
  automationHint?: string | null;
  /** A recipe exists for this rule. */
  recipeAvailable?: boolean;
  /** A recipe exists but this particular occurrence fails its preconditions. */
  recipeBlocked?: boolean;
}

export interface RuleMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  language: string;
  category: Category;
  defaultSeverity: Severity;
  defaultMigrationLevel: MigrationLevel;
  basis: string;
  recipeId?: string;
  enabled: boolean;
  testStatus: string;
  tags: string[];
  implemented?: boolean;
}

export interface RecordedRecipe {
  id: string;
  name: string;
  level: 'SAFE' | 'CONDITIONAL';
  summary: string;
  caveats: string[];
}

export interface ScanSummary {
  scanTaskId: string;
  totals: {
    files: number;
    findings: number;
    highRisk: number;
    autoConvertible: number;
    manual: number;
    parseFailures: number;
    unsupported: number;
    automationCandidates: number;
    ignored: number;
  };
  byCategory: Array<{ category: Category; label: string; count: number }>;
  bySeverity: Array<{ severity: Severity; count: number }>;
  byMigrationLevel: Array<{ level: MigrationLevel; count: number }>;
  byStatus: Array<{ status: FindingStatus; count: number }>;
  topFiles: Array<{ filePath: string; count: number; highRisk: number }>;
  topRules: Array<{ ruleId: string; name: string; count: number }>;
  parseProblems: Array<{ filePath: string; phase: string; message: string; line?: number; column?: number; recovered: boolean }>;
}

export interface Relation {
  fromPath: string;
  toPath: string;
  kind: 'SCRIPT_SRC' | 'STYLESHEET' | 'JS_IMPORT' | 'SHARED_FUNCTION' | 'SHARED_FUNCTION_CALL';
  confidence: 'CONFIRMED' | 'INFERRED' | 'UNKNOWN';
  evidence: string;
  line?: number;
}

export interface PlanItem {
  findingId: string;
  ruleId: string;
  recipeId: string;
  filePath: string;
  migrationLevel: MigrationLevel;
  applicable: boolean;
  blockedReasons: string[];
  fileHashAtPreview: string;
  edits: Array<{ start: number; end: number; newText: string; ruleId: string; reason: string }>;
  diff: Array<{ type: 'equal' | 'add' | 'del'; oldLine: number | null; newLine: number | null; text: string }>;
  unifiedDiff: string;
  previewBefore: string;
  previewAfter: string;
  startLine: number;
}

export interface MigrationPlan {
  planId: string;
  projectId: string;
  scanTaskId: string;
  items: PlanItem[];
  warnings: string[];
}

export interface MigrationExecution {
  id: string;
  projectId: string;
  scanTaskId: string;
  ruleId: string;
  findingId: string;
  filePath: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
  executionStatus: 'APPLIED' | 'ROLLED_BACK' | 'FAILED';
  validationStatus: 'PENDING' | 'PASSED' | 'FAILED' | 'SKIPPED';
  executedAt: string;
  rolledBackAt: string | null;
  backupPath: string;
  note: string | null;
  /** One atomic file write; every finding in the batch reverts together. */
  batchId: string | null;
  /** One execute() call; spans every file the plan touched. */
  sessionId: string | null;
}

export interface RollbackResult {
  ok: boolean;
  reason?: string;
  affectedFindings?: number;
  batchId?: string | null;
  sessionId?: string | null;
}

export interface VisualValidationResult {
  available: boolean;
  reason?: string;
  pageKey: string;
  url: string;
  width: number;
  height: number;
  screenshotPath: string;
  baselinePath: string | null;
  baselineCreated: boolean;
  diffPercent: number;
  changedPixels: number;
  totalPixels: number;
  dimensionMismatch: boolean;
  consoleErrors: string[];
  durationMs: number;
  screenshotDataUrl?: string;
  baselineDataUrl?: string;
}

export interface ExecuteResult {
  ok: boolean;
  executions: MigrationExecution[];
  failures: Array<{ findingId: string; filePath: string; reason: string }>;
  warnings: string[];
  sessionId: string;
  /** True when the plan was rejected and nothing was written. */
  aborted: boolean;
}

export interface ValidationReport {
  scanTaskId: string;
  executedAt: string;
  scope: 'STATIC' | 'BROWSER';
  findingsChecked: number;
  findingsResolved: number;
  findingsStillPresent: number;
  newSyntaxErrors: Array<{ filePath: string; message: string; line?: number }>;
  postConditionFailures: string[];
  browser?: {
    available: boolean;
    reason?: string;
    url?: string;
    pageLoaded?: boolean;
    navigationFailures: string[];
    consoleErrors: string[];
    durationMs?: number;
  };
  passed: boolean;
  notes: string[];
}

export interface IgnoreRule {
  id: string;
  projectId: string;
  ruleId: string | null;
  pathPattern: string | null;
  reason: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

export interface ScanFile {
  id: string;
  scanTaskId: string;
  path: string;
  language: string;
  size: number;
  hash: string;
  encoding: string;
  parseStatus: 'PARSED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  findingCount: number;
}

export interface Meta {
  version: string;
  ruleStats: { total: number; byCategory: Record<string, number>; byLanguage: Record<string, number> };
  categories: Category[];
  severities: Severity[];
  migrationLevels: MigrationLevel[];
  statuses: FindingStatus[];
  languages: string[];
  defaultEncodings: string[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Non-JSON error bodies keep the status text.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  meta: () => request<Meta>('/meta'),
  health: () => request<{ ok: boolean; version: string; rules: number; recipes: number }>('/health'),

  listProjects: () => request<{ items: Project[] }>('/projects'),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  createProject: (body: { name: string; rootPath: string; config?: Partial<ProjectConfig> }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: string, body: { name?: string; rootPath?: string; config?: Partial<ProjectConfig> }) =>
    request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: string) => request<{ deleted: boolean; note: string }>(`/projects/${id}`, { method: 'DELETE' }),

  listIgnoreRules: (projectId: string) => request<{ items: IgnoreRule[] }>(`/projects/${projectId}/ignore-rules`),
  createIgnoreRule: (projectId: string, body: { ruleId?: string | null; pathPattern?: string | null; reason: string }) =>
    request<IgnoreRule>(`/projects/${projectId}/ignore-rules`, { method: 'POST', body: JSON.stringify(body) }),
  setIgnoreRuleEnabled: (id: string, enabled: boolean) =>
    request<{ id: string; enabled: boolean }>(`/ignore-rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteIgnoreRule: (id: string) => request<{ deleted: boolean }>(`/ignore-rules/${id}`, { method: 'DELETE' }),

  listScans: (projectId?: string, limit = 100) =>
    request<{ items: ScanTask[] }>(`/scans?${projectId ? `projectId=${projectId}&` : ''}limit=${limit}`),
  getScan: (id: string) => request<ScanTask>(`/scans/${id}`),
  startScan: (projectId: string, config?: Partial<ProjectConfig>) =>
    request<ScanTask>(`/projects/${projectId}/scans`, { method: 'POST', body: JSON.stringify({ config }) }),
  cancelScan: (id: string) => request<{ cancelled: boolean }>(`/scans/${id}/cancel`, { method: 'POST' }),
  scanLogs: (id: string) => request<{ items: Array<{ at: string; level: string; phase: string | null; message: string }> }>(`/scans/${id}/logs`),
  summary: (id: string) => request<ScanSummary>(`/scans/${id}/summary`),
  scanFiles: (id: string) => request<{ items: ScanFile[] }>(`/scans/${id}/files`),
  scanSource: (id: string, path: string) =>
    request<{ path: string; language: string; content: string; stale: boolean; encoding: string; parseStatus: string }>(
      `/scans/${id}/files/source?path=${encodeURIComponent(path)}`,
    ),

  findings: (scanId: string, params: Record<string, string | number | undefined> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<{ total: number; items: Finding[] }>(`/scans/${scanId}/findings?${query.toString()}`);
  },
  finding: (id: string) =>
    request<{
      finding: Finding;
      projectId: string | null;
      projectName: string | null;
      rule: RuleMeta | null;
      recipe: RecordedRecipe | null;
      history: Array<{ id: string; fromStatus: string | null; toStatus: string; actor: string; note: string | null; at: string }>;
    }>(`/findings/${id}`),
  findingSource: (id: string) =>
    request<{ path: string; language: string; content: string; stale: boolean }>(`/findings/${id}/source`),
  setFindingStatus: (id: string, status: FindingStatus, note?: string) =>
    request<Finding>(`/findings/${id}/status`, { method: 'POST', body: JSON.stringify({ status, note }) }),

  relations: (scanId: string) => request<{ items: Relation[] }>(`/scans/${scanId}/relations`),

  rules: () => request<{ items: RuleMeta[]; total: number }>('/rules'),
  rule: (id: string) => request<{ rule: RuleMeta; recipe: RecordedRecipe | null }>(`/rules/${id}`),
  setRuleEnabled: (id: string, enabled: boolean) =>
    request<{ id: string; enabled: boolean }>(`/rules/${id}/state`, { method: 'POST', body: JSON.stringify({ enabled }) }),

  preview: (scanTaskId: string, findingIds: string[]) =>
    request<MigrationPlan>('/migrations/preview', { method: 'POST', body: JSON.stringify({ scanTaskId, findingIds }) }),
  execute: (scanTaskId: string, findingIds: string[]) =>
    request<ExecuteResult>('/migrations/execute', { method: 'POST', body: JSON.stringify({ scanTaskId, findingIds }) }),
  rollback: (executionId: string) => request<RollbackResult>(`/migrations/${executionId}/rollback`, { method: 'POST' }),
  rollbackBatch: (batchId: string) => request<RollbackResult>(`/migrations/batch/${batchId}/rollback`, { method: 'POST' }),
  rollbackSession: (sessionId: string) => request<RollbackResult>(`/migrations/session/${sessionId}/rollback`, { method: 'POST' }),
  migrations: (scanTaskId?: string) =>
    request<{ items: MigrationExecution[] }>(`/migrations?${scanTaskId ? `scanTaskId=${scanTaskId}` : ''}`),

  validateStatic: (scanId: string, filePaths?: string[]) =>
    request<ValidationReport>(`/scans/${scanId}/validation/static`, {
      method: 'POST',
      body: JSON.stringify({ filePaths }),
    }),
  validateVisual: (scanId: string, body: { url: string; pageKey: string; updateBaseline?: boolean; width?: number; height?: number }) =>
    request<VisualValidationResult>(`/scans/${scanId}/validation/visual`, { method: 'POST', body: JSON.stringify(body) }),
  validateBrowser: (scanId: string, url: string) =>
    request<ValidationReport>(`/scans/${scanId}/validation/browser`, { method: 'POST', body: JSON.stringify({ url }) }),

  reportUrl: (scanId: string, format: 'json' | 'csv' | 'html') => `/api/scans/${scanId}/report?format=${format}`,
};

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const started = new Date(start).getTime();
  const finished = end ? new Date(end).getTime() : Date.now();
  const seconds = Math.max(0, (finished - started) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/**
 * WebLift domain model.
 * Position conventions used everywhere in the codebase:
 *  - line / column are 1-based (user-facing)
 *  - offset is 0-based (used for slicing and text edits)
 * Every finding must carry traceable location info; "this file has issues" is never acceptable.
 */

export type Language = 'javascript' | 'html' | 'css' | 'jsp';

export const LANGUAGE_BY_EXTENSION: Record<string, Language> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.css': 'css',
  '.jsp': 'jsp',
  '.jspf': 'jsp',
  '.jspx': 'jsp',
  '.tag': 'jsp',
};

/** Technical category, drives the dashboard category chart. */
export type Category =
  | 'JS_API'
  | 'DOM_API'
  | 'HTML_COMPAT'
  | 'CSS_COMPAT'
  | 'ACTIVEX_VBSCRIPT'
  | 'BROWSER_BEHAVIOR'
  | 'DYNAMIC_CODE';

export const CATEGORY_LABELS: Record<Category, string> = {
  JS_API: 'JavaScript API',
  DOM_API: 'DOM API',
  HTML_COMPAT: 'HTML 兼容性',
  CSS_COMPAT: 'CSS 兼容性',
  ACTIVEX_VBSCRIPT: 'ActiveX / VBScript',
  BROWSER_BEHAVIOR: '浏览器行为差异',
  DYNAMIC_CODE: '动态代码与未知依赖',
};

/** Business risk, tracked independently from migration difficulty. */
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

/** Automation level for migration. */
export type MigrationLevel = 'SAFE' | 'CONDITIONAL' | 'MANUAL' | 'UNSUPPORTED';

/**
 * Analysis confidence: how certain the analyzer is that the pattern matched.
 * It never implies severity, nor whether automated conversion is safe.
 */
export type Confidence = 'CONFIRMED' | 'POSSIBLE' | 'NEEDS_ANALYSIS';

export type FindingStatus =
  | 'DETECTED'
  | 'READY_FOR_MIGRATION'
  | 'MIGRATED'
  | 'REVIEW_REQUIRED'
  | 'VALIDATED'
  | 'VALIDATION_FAILED'
  | 'IGNORED';

export type ScanStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_WARNINGS'
  | 'FAILED'
  | 'CANCELLED';

export const SCAN_PHASES = [
  'FILE_DISCOVERY',
  'FILE_CLASSIFICATION',
  'PARSING',
  'IE_DETECTION',
  'REFERENCE_ANALYSIS',
  'FINDING_MERGE',
  'PERSISTENCE',
  'REPORT_GENERATION',
] as const;

export type ScanPhase = (typeof SCAN_PHASES)[number];

export const SCAN_PHASE_LABELS: Record<ScanPhase, string> = {
  FILE_DISCOVERY: '文件发现',
  FILE_CLASSIFICATION: '文件分类',
  PARSING: '语法解析',
  IE_DETECTION: 'IE 特征检测',
  REFERENCE_ANALYSIS: '跨文件引用分析',
  FINDING_MERGE: '问题归并',
  PERSISTENCE: '结果保存',
  REPORT_GENERATION: '报告生成',
};

export interface SourceLocation {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
}

export interface SourceFile {
  /** POSIX path relative to the project root */
  path: string;
  absolutePath: string;
  language: Language;
  size: number;
  /** sha256 of raw bytes */
  hash: string;
  content: string;
  lineCount: number;
}

export interface ParseProblem {
  filePath: string;
  phase: 'READ' | 'DECODE' | 'PARSE';
  message: string;
  line?: number;
  column?: number;
  /** Whether the file was still partially analyzed (error recovery) */
  recovered: boolean;
}

/** A single finding. Field names match the AnalysisFinding entity in the spec. */
export interface AnalysisFinding {
  id: string;
  scanTaskId: string;
  ruleId: string;
  ruleVersion: string;
  filePath: string;
  language: Language;
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
  /**
   * Locale-neutral key for the one-line message, e.g. "rules.WL-CSS-004.obsolete".
   * Long-form risk/recommendation stay English on purpose; only the summary line is
   * translated, because it is what every list in the UI shows.
   */
  messageKey: string;
  messageParams: Record<string, string | number>;
  /** Why this code may be incompatible with Chrome */
  risk: string;
  /** Evidence: AST node kind, attribute name, masked region, etc. */
  evidence: FindingEvidence;
  recommendation: string;
  snippet: string;
  status: FindingStatus;
  statusUpdatedAt: string;
  statusNote?: string;
}

export interface FindingEvidence {
  /** Evidence kind, e.g. MemberExpression / Attribute / CssDeclaration */
  kind: string;
  /** Matched source text */
  matched: string;
  /** Structured supplementary data */
  detail: Record<string, string | number | boolean | null>;
  /** Whether the hit sits near a JSP dynamic region (affects analyzability) */
  touchesDynamicRegion?: boolean;
  /** Container of the analyzed fragment, e.g. <script> or an onclick attribute */
  container?: string;
}

export interface MigrationRule {
  id: string;
  name: string;
  version: string;
  description: string;
  language: Language | 'any';
  category: Category;
  /** Highest severity this rule can report */
  defaultSeverity: Severity;
  /** Highest automation level this rule can offer */
  defaultMigrationLevel: MigrationLevel;
  /** Detection basis, rendered in the Rule Explorer */
  basis: string;
  /** Linked recipe id, when a recipe exists */
  recipeId?: string;
  enabled: boolean;
  /** Test coverage status, registered by the test suite */
  testStatus: 'COVERED' | 'PARTIAL' | 'NONE';
  tags: string[];
}

/** Relationship confidence is about evidence strength, not about finding confidence. */
export type RelationConfidence = 'CONFIRMED' | 'INFERRED' | 'UNKNOWN';

export interface FileReference {
  fromPath: string;
  toPath: string;
  kind: 'SCRIPT_SRC' | 'STYLESHEET' | 'JS_IMPORT' | 'SHARED_FUNCTION' | 'SHARED_FUNCTION_CALL';
  /** CONFIRMED has static evidence; INFERRED comes from symbol analysis; UNKNOWN means dynamic. */
  confidence: RelationConfidence;
  evidence: string;
  line?: number;
}

export interface ProjectConfig {
  includeExtensions: string[];
  excludeDirs: string[];
  excludeGlobs: string[];
  maxFileSizeBytes: number;
  maxDepth: number;
  /** Candidate encodings for heuristic detection; defaults to UTF-8, Shift_JIS, EUC-JP, ISO-2022-JP, UTF-16. */
  encodingCandidates: string[];
  /** Forces a single encoding for every file in the project. */
  forceEncoding?: string;
  modules: ProjectModule[];
}

export interface ProjectModule {
  name: string;
  /** Directory relative to root; '.' means the root itself */
  path: string;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  config: ProjectConfig;
  createdAt: string;
  updatedAt: string;
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
  /** Project config snapshot captured when the scan started */
  configSnapshot: ProjectConfig;
  /** Fingerprint of the rule + recipe set used for this scan; reuse is only valid when it matches. */
  ruleSignature: string | null;
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
    /** MANUAL findings where a mechanical rewrite exists in principle but no recipe ships yet. */
    automationCandidates: number;
    /** Findings silenced by a project ignore rule. */
    ignored: number;
  };
  byCategory: Array<{ category: Category; label: string; count: number }>;
  bySeverity: Array<{ severity: Severity; count: number }>;
  byMigrationLevel: Array<{ level: MigrationLevel; count: number }>;
  byStatus: Array<{ status: FindingStatus; count: number }>;
  topFiles: Array<{ filePath: string; count: number; highRisk: number }>;
  topRules: Array<{ ruleId: string; name: string; count: number }>;
  parseProblems: ParseProblem[];
}

export interface MigrationPlan {
  planId: string;
  projectId: string;
  scanTaskId: string;
  items: MigrationPlanItem[];
  warnings: string[];
}

export interface MigrationPlanItem {
  findingId: string;
  ruleId: string;
  recipeId: string;
  filePath: string;
  migrationLevel: MigrationLevel;
  applicable: boolean;
  blockedReasons: string[];
  fileHashAtPreview: string;
  edits: TextEdit[];
  diff: DiffHunk[];
  unifiedDiff: string;
  previewBefore: string;
  previewAfter: string;
  startLine: number;
  /**
   * True when the file changed after the scan. Unlike a precondition failure this is not
   * an "excluded" finding: the confirmed plan is no longer valid, so the whole
   * transaction must be refused.
   */
  staleFile: boolean;
}

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
  ruleId: string;
  reason: string;
}

export interface DiffHunk {
  type: 'equal' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export type ExecutionStatus = 'APPLIED' | 'ROLLED_BACK' | 'FAILED';
export type ValidationStatus = 'PENDING' | 'PASSED' | 'FAILED' | 'SKIPPED';

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
  executionStatus: ExecutionStatus;
  validationStatus: ValidationStatus;
  executedAt: string;
  rolledBackAt: string | null;
  /** Relative backup path used for rollback */
  backupPath: string;
  note: string | null;
  /**
   * One atomic file write. Several findings applied to the same file share a batch,
   * because they are written together and can only be rolled back together.
   */
  batchId: string | null;
  /**
   * One execute() call. A session spans every file the plan touched, so a multi-file
   * migration is all-or-nothing and can be reverted as a unit.
   */
  sessionId: string | null;
}

/**
 * A project-level decision to stop reporting a class of finding.
 *
 * Scoped by rule and/or path so "we accept this here" is expressible, instead of
 * ignoring findings one by one and losing the decision on the next scan.
 */
export interface IgnoreRule {
  id: string;
  projectId: string;
  /** null = every rule */
  ruleId: string | null;
  /** Glob relative to the project root; null = every file */
  pathPattern: string | null;
  reason: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

/** One page compared across a migration: captured before and after the write. */
export interface MigrationVisualResult {
  pageKey: string;
  url: string;
  captured: boolean;
  reason?: string;
  width: number;
  height: number;
  diffPercent: number;
  changedPixels: number;
  totalPixels: number;
  dimensionMismatch: boolean;
  beforeDataUrl?: string;
  afterDataUrl?: string;
}

/** Stored reference screenshot for one page of a project. */
export interface VisualBaseline {
  id: string;
  projectId: string;
  pageKey: string;
  url: string;
  path: string;
  width: number;
  height: number;
  hash: string;
  createdAt: string;
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
  /** Percentage of differing pixels against the baseline, 0 when a baseline was just created. */
  diffPercent: number;
  changedPixels: number;
  totalPixels: number;
  dimensionMismatch: boolean;
  consoleErrors: string[];
  durationMs: number;
  /** Inline previews so the UI never has to fetch arbitrary file paths. */
  screenshotDataUrl?: string;
  baselineDataUrl?: string;
}

export interface ValidationReport {
  scanTaskId: string;
  executedAt: string;
  scope: 'STATIC' | 'BROWSER';
  findingsChecked: number;
  findingsResolved: number;
  findingsStillPresent: number;
  newSyntaxErrors: ParseProblem[];
  postConditionFailures: string[];
  browser?: BrowserValidationResult;
  passed: boolean;
  notes: string[];
}

export interface BrowserValidationResult {
  available: boolean;
  reason?: string;
  url?: string;
  pageLoaded?: boolean;
  navigationFailures: string[];
  consoleErrors: string[];
  durationMs?: number;
}

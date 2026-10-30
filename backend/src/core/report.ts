import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Category, FindingStatus, MigrationLevel, ScanSummary, Severity } from '../model/types.js';
import { CATEGORY_LABELS } from '../model/types.js';
import type { Store } from '../storage/store.js';
import { automationStatus } from '../recipes/registry.js';
import { modulePathOf } from './scanner.js';

export function dataRoot(): string {
  return process.env.WEBLIFT_DATA_DIR ?? resolve(process.cwd(), 'data');
}

export function reportsDir(): string {
  const dir = join(dataRoot(), 'reports');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Aggregates a scan into the numbers the dashboard renders. Everything comes from stored rows. */
export function buildSummary(store: Store, scanId: string): ScanSummary {
  const scan = store.getScan(scanId);
  const findings = store.listAllFindings(scanId);
  const problems = store.listParseProblems(scanId);
  const files = store.listScanFiles(scanId);

  const config = scan?.configSnapshot ?? null;
  const byModuleMap = new Map<string, { count: number; highRisk: number }>();
  const byCategoryMap = new Map<Category, number>();
  const bySeverityMap = new Map<Severity, number>();
  const byLevelMap = new Map<MigrationLevel, number>();
  const byStatusMap = new Map<FindingStatus, number>();
  const byFile = new Map<string, { count: number; highRisk: number }>();
  const byRule = new Map<string, number>();

  for (const finding of findings) {
    byCategoryMap.set(finding.category, (byCategoryMap.get(finding.category) ?? 0) + 1);
    bySeverityMap.set(finding.severity, (bySeverityMap.get(finding.severity) ?? 0) + 1);
    byLevelMap.set(finding.migrationLevel, (byLevelMap.get(finding.migrationLevel) ?? 0) + 1);
    byStatusMap.set(finding.status, (byStatusMap.get(finding.status) ?? 0) + 1);
    byRule.set(finding.ruleId, (byRule.get(finding.ruleId) ?? 0) + 1);
    if (config) {
      const moduleName = modulePathOf(finding.filePath, config);
      const entry = byModuleMap.get(moduleName) ?? { count: 0, highRisk: 0 };
      entry.count += 1;
      if (finding.severity === 'HIGH') entry.highRisk += 1;
      byModuleMap.set(moduleName, entry);
    }
    const fileEntry = byFile.get(finding.filePath) ?? { count: 0, highRisk: 0 };
    fileEntry.count += 1;
    if (finding.severity === 'HIGH') fileEntry.highRisk += 1;
    byFile.set(finding.filePath, fileEntry);
  }

  const categories: Category[] = [
    'JS_API',
    'DOM_API',
    'HTML_COMPAT',
    'CSS_COMPAT',
    'ACTIVEX_VBSCRIPT',
    'BROWSER_BEHAVIOR',
    'DYNAMIC_CODE',
  ];
  const severities: Severity[] = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
  const levels: MigrationLevel[] = ['SAFE', 'CONDITIONAL', 'MANUAL', 'UNSUPPORTED'];
  const statuses: FindingStatus[] = [
    'DETECTED',
    'READY_FOR_MIGRATION',
    'MIGRATED',
    'REVIEW_REQUIRED',
    'VALIDATED',
    'VALIDATION_FAILED',
    'IGNORED',
  ];

  return {
    scanTaskId: scanId,
    totals: {
      files: files.length || scan?.scannedFileCount || 0,
      findings: findings.length,
      highRisk: bySeverityMap.get('HIGH') ?? 0,
      autoConvertible: (byLevelMap.get('SAFE') ?? 0) + (byLevelMap.get('CONDITIONAL') ?? 0),
      manual: byLevelMap.get('MANUAL') ?? 0,
      parseFailures: files.filter((file) => file.parseStatus === 'FAILED').length,
      unsupported: byLevelMap.get('UNSUPPORTED') ?? 0,
      automationCandidates: findings.filter((finding) => automationStatus(finding.ruleId, finding.evidence.detail) === 'PLANNED')
        .length,
      ignored: byStatusMap.get('IGNORED') ?? 0,
    },
    byCategory: categories.map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      count: byCategoryMap.get(category) ?? 0,
    })),
    byModule: [...byModuleMap.entries()]
      .map(([moduleName, value]) => ({ module: moduleName, ...value }))
      .sort((a, b) => b.count - a.count),
    bySeverity: severities.map((severity) => ({ severity, count: bySeverityMap.get(severity) ?? 0 })),
    byMigrationLevel: levels.map((level) => ({ level, count: byLevelMap.get(level) ?? 0 })),
    byStatus: statuses.map((status) => ({ status, count: byStatusMap.get(status) ?? 0 })),
    topFiles: [...byFile.entries()]
      .map(([filePath, value]) => ({ filePath, ...value }))
      .sort((a, b) => b.highRisk - a.highRisk || b.count - a.count)
      .slice(0, 12),
    topRules: [...byRule.entries()]
      .map(([ruleId, count]) => ({ ruleId, name: ruleId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    byRule: [...byRule.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count),
    parseProblems: problems.slice(0, 200),
  };
}

interface ReportPayload {
  generatedAt: string;
  project: { id: string; name: string; rootPath: string } | null;
  scan: ReturnType<Store['getScan']>;
  scope: unknown;
  summary: ScanSummary;
  findings: ReturnType<Store['listAllFindings']>;
  relations: ReturnType<Store['listRelations']>;
  unresolvedRelations: unknown[];
  parseProblems: ReturnType<Store['listParseProblems']>;
  ruleHits: Array<{ ruleId: string; count: number }>;
  /** What was actually changed, and what the verification said about it. */
  migrations: ReturnType<Store['listMigrations']>;
  validations: ReturnType<Store['listValidationRuns']>;
}

function buildPayload(store: Store, scanId: string): ReportPayload {
  const scan = store.getScan(scanId);
  const summary = buildSummary(store, scanId);
  const findings = store.listAllFindings(scanId);
  const ruleCounts = new Map<string, number>();
  for (const finding of findings) ruleCounts.set(finding.ruleId, (ruleCounts.get(finding.ruleId) ?? 0) + 1);

  return {
    generatedAt: new Date().toISOString(),
    project: scan ? { id: scan.projectId, name: scan.projectName, rootPath: scan.rootPath } : null,
    scan,
    scope: scan?.configSnapshot ?? null,
    summary,
    findings,
    relations: store.listRelations(scanId),
    unresolvedRelations: [],
    parseProblems: store.listParseProblems(scanId),
    ruleHits: [...ruleCounts.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count),
    migrations: store.listMigrations(scanId, 200),
    validations: store.listValidationRuns(scanId),
  };
}

export function writeScanReport(store: Store, scanId: string): string {
  const payload = buildPayload(store, scanId);
  const file = join(reportsDir(), `${scanId}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

export function reportAsJson(store: Store, scanId: string): string {
  return JSON.stringify(buildPayload(store, scanId), null, 2);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function reportAsCsv(store: Store, scanId: string): string {
  const findings = store.listAllFindings(scanId);
  const header = [
    'rule_id',
    'severity',
    'migration_level',
    'category',
    'confidence',
    'file_path',
    'start_line',
    'end_line',
    'start_column',
    'end_column',
    'status',
    'message',
    'evidence',
    'recommendation',
  ];
  const rows = findings.map((finding) =>
    [
      finding.ruleId,
      finding.severity,
      finding.migrationLevel,
      finding.category,
      finding.confidence,
      finding.filePath,
      finding.startLine,
      finding.endLine,
      finding.startColumn,
      finding.endColumn,
      finding.status,
      finding.message,
      `${finding.evidence.kind}: ${finding.evidence.matched}`,
      finding.recommendation,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function reportAsHtml(store: Store, scanId: string): string {
  const payload = buildPayload(store, scanId);
  const { summary, scan } = payload;
  const autoCandidates = payload.findings.filter((f) => f.migrationLevel === 'SAFE' || f.migrationLevel === 'CONDITIONAL');
  const manual = payload.findings.filter((f) => f.migrationLevel === 'MANUAL' || f.migrationLevel === 'UNSUPPORTED');
  const dynamic = payload.findings.filter((f) => f.category === 'DYNAMIC_CODE');

  const stat = (label: string, value: number | string): string =>
    `<div class="stat"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div></div>`;

  const findingRows = payload.findings
    .slice(0, 500)
    .map(
      (f) => `<tr>
        <td><span class="sev sev-${escapeHtml(f.severity.toLowerCase())}">${escapeHtml(f.severity)}</span></td>
        <td class="mono" style="white-space: nowrap">${escapeHtml(f.ruleId)}</td>
        <td class="mono">${escapeHtml(f.filePath)}:${f.startLine}:${f.startColumn}</td>
        <td>${escapeHtml(f.message)}</td>
        <td>${escapeHtml(f.migrationLevel)}</td>
        <td>${escapeHtml(f.status)}</td>
      </tr>`,
    )
    .join('\n');

  const appliedCount = payload.migrations.filter((execution) => execution.executionStatus === 'APPLIED').length;
  const unconfirmedCount = payload.migrations.filter((execution) => execution.executionStatus === 'PENDING').length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>WebLift report — ${escapeHtml(scan?.projectName ?? scanId)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: ui-sans-serif, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; margin: 0; padding: 40px; background: #f7f8fa; color: #14161a; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #5b6472; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 24px 0; }
  .stat { background: #fff; border: 1px solid #e3e6ec; border-radius: 10px; padding: 14px 16px; }
  .stat-value { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; }
  .stat-label { color: #626b7a; font-size: 12px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e6ec; border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #eef0f4; vertical-align: top; }
  th { background: #fafbfc; font-weight: 600; color: #3c4453; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .sev { display: inline-block; padding: 2px 7px; border-radius: 5px; font-size: 11px; font-weight: 600; }
  .sev-high { background: #fdecec; color: #b3261e; }
  .sev-medium { background: #fff4e5; color: #9a5b00; }
  .sev-low { background: #eef4ff; color: #2b5aa8; }
  .sev-unknown { background: #f1f2f5; color: #5b6472; }
  h2 { font-size: 15px; margin: 32px 0 10px; }
  .note { color: #5b6472; font-size: 12px; margin-top: 8px; }
  ul { font-size: 13px; color: #3c4453; }
</style>
</head>
<body>
  <h1>WebLift migration report</h1>
  <div class="meta">
    Project <strong>${escapeHtml(scan?.projectName ?? '')}</strong> ·
    root <span class="mono">${escapeHtml(scan?.rootPath ?? '')}</span> ·
    scan <span class="mono">${escapeHtml(scanId)}</span> ·
    status ${escapeHtml(scan?.status ?? '')} ·
    generated ${escapeHtml(payload.generatedAt)}
  </div>

  <div class="grid">
    ${stat('Files scanned', summary.totals.files)}
    ${stat('Findings', summary.totals.findings)}
    ${stat('High risk', summary.totals.highRisk)}
    ${stat('Auto convertible', summary.totals.autoConvertible)}
    ${stat('Manual review', summary.totals.manual)}
    ${stat('Unsupported', summary.totals.unsupported)}
    ${stat('Parse failures', summary.totals.parseFailures)}
  </div>

  <h2>Findings by category</h2>
  <table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>
    ${summary.byCategory.map((c) => `<tr><td>${escapeHtml(c.label)}</td><td>${c.count}</td></tr>`).join('')}
  </tbody></table>

  <h2>Auto-migration candidates (${autoCandidates.length})</h2>
  <ul>${autoCandidates
    .slice(0, 40)
    .map((f) => `<li class="mono">${escapeHtml(f.filePath)}:${f.startLine} — ${escapeHtml(f.ruleId)} ${escapeHtml(f.message)}</li>`)
    .join('') || '<li>None</li>'}</ul>

  <h2>Manual / unsupported (${manual.length})</h2>
  <ul>${manual
    .slice(0, 40)
    .map((f) => `<li class="mono">${escapeHtml(f.filePath)}:${f.startLine} — ${escapeHtml(f.ruleId)} ${escapeHtml(f.migrationLevel)}</li>`)
    .join('') || '<li>None</li>'}</ul>

  <h2>Dynamic and unknown dependencies (${dynamic.length})</h2>
  <ul>${dynamic
    .slice(0, 40)
    .map((f) => `<li class="mono">${escapeHtml(f.filePath)}:${f.startLine} — ${escapeHtml(f.message)}</li>`)
    .join('') || '<li>None</li>'}</ul>

  <h2>Migrations applied (${appliedCount})</h2>
  ${
    unconfirmedCount > 0
      ? `<p class="note">${unconfirmedCount} row(s) below are PENDING: the transaction was recorded but never confirmed, which means the process stopped between the write and its confirmation. Roll back from the tool to restore the backup (or to confirm nothing was written).</p>`
      : ''
  }
  ${
    payload.migrations.length === 0
      ? '<p class="note">No migration was applied for this scan.</p>'
      : `<table>
    <thead><tr><th>File</th><th>Rule</th><th>Status</th><th>Validation</th><th>Executed</th><th>Session</th></tr></thead>
    <tbody>${payload.migrations
      .map(
        (execution) => `<tr>
          <td class="mono">${escapeHtml(execution.filePath)}</td>
          <td class="mono">${escapeHtml(execution.ruleId)}</td>
          <td>${escapeHtml(execution.executionStatus)}</td>
          <td>${escapeHtml(execution.validationStatus)}</td>
          <td>${escapeHtml(execution.executedAt)}</td>
          <td class="mono">${escapeHtml((execution.sessionId ?? '').slice(0, 12))}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`
  }

  <h2>Verification runs (${payload.validations.length})</h2>
  ${
    payload.validations.length === 0
      ? '<p class="note">No verification was run for this scan.</p>'
      : payload.validations
          .map((run) => {
            const visual = (run.payload as { results?: Array<Record<string, unknown>> }).results;
            const rows = Array.isArray(visual)
              ? `<table style="margin-top:8px">
    <thead><tr><th>Page</th><th>URL</th><th>Captured</th><th>Diff</th><th>Changed pixels</th><th>Size change</th></tr></thead>
    <tbody>${visual
      .map(
        (result) => `<tr>
          <td class="mono">${escapeHtml(result.pageKey)}</td>
          <td class="mono">${escapeHtml(result.url)}</td>
          <td>${result.captured ? 'yes' : `no — ${escapeHtml(result.reason)}`}</td>
          <td>${result.captured ? `${escapeHtml(result.diffPercent)}%` : '—'}</td>
          <td>${result.captured ? escapeHtml(result.changedPixels) : '—'}</td>
          <td>${result.dimensionMismatch ? 'yes' : 'no'}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`
              : '';
            return `<div style="margin-bottom:14px">
      <div><strong>${escapeHtml(run.scope)}</strong>
        <span class="sev ${run.passed ? 'sev-low' : 'sev-high'}">${run.passed ? 'PASSED' : 'FAILED'}</span>
        <span class="meta">${escapeHtml(run.executedAt)}</span>
      </div>
      ${rows}
    </div>`;
          })
          .join('')
  }

  <h2>Findings (first 500 of ${payload.findings.length})</h2>
  <table>
    <thead><tr><th>Severity</th><th>Rule</th><th>Location</th><th>Message</th><th>Migration</th><th>Status</th></tr></thead>
    <tbody>${findingRows}</tbody>
  </table>
  <p class="note">Locations are 1-based line and column in the original source file. Scan results are only valid for the file hashes captured during this scan; re-scan after any source change.</p>
</body>
</html>`;
}

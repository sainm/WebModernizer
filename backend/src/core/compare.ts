import type { AnalysisFinding, Severity } from '../model/types.js';

/**
 * Identity of a finding across scans.
 *
 * Line numbers and offsets cannot be used: any edit above a finding shifts them, and then a
 * productive migration would look like "everything resolved, everything new". The rule plus
 * the file plus the normalised snippet survives edits elsewhere in the file, and differs when
 * the code itself was actually rewritten.
 */
export function findingKey(finding: Pick<AnalysisFinding, 'ruleId' | 'filePath' | 'snippet'>): string {
  const snippet = finding.snippet.replace(/\s+/g, ' ').trim();
  return `${finding.ruleId}|${finding.filePath}|${snippet}`;
}

export interface CompareRollup {
  ruleId: string;
  resolved: number;
  added: number;
}

export interface FileRollup {
  filePath: string;
  resolved: number;
  added: number;
}

export interface CompareResult {
  /** Present in the baseline, gone now. */
  resolved: AnalysisFinding[];
  /** Not in the baseline, present now. */
  added: AnalysisFinding[];
  /** Matched on both sides. */
  unchanged: number;
  baselineTotal: number;
  currentTotal: number;
  byRule: CompareRollup[];
  byFile: FileRollup[];
}

/**
 * Multiset comparison: a file can legitimately contain the same snippet twice, so occurrences
 * are counted per key instead of deduplicated — otherwise "fixed one of three" would read as
 * "unchanged" or as "two added".
 */
export function compareFindings(baseline: AnalysisFinding[], current: AnalysisFinding[]): CompareResult {
  const group = (findings: AnalysisFinding[]): Map<string, AnalysisFinding[]> => {
    const map = new Map<string, AnalysisFinding[]>();
    for (const finding of findings) {
      const key = findingKey(finding);
      const list = map.get(key) ?? [];
      list.push(finding);
      map.set(key, list);
    }
    return map;
  };

  const before = group(baseline);
  const after = group(current);
  const resolved: AnalysisFinding[] = [];
  const added: AnalysisFinding[] = [];
  let unchanged = 0;

  for (const [key, list] of before) {
    const now = after.get(key) ?? [];
    if (now.length >= list.length) {
      unchanged += list.length;
      continue;
    }
    unchanged += now.length;
    // Keep the earliest occurrences as "still there"; the surplus counts as resolved.
    resolved.push(...list.slice(now.length));
  }
  for (const [key, list] of after) {
    const previously = before.get(key) ?? [];
    if (list.length > previously.length) added.push(...list.slice(previously.length));
  }

  const ruleMap = new Map<string, CompareRollup>();
  const bump = (bucket: Map<string, { resolved: number; added: number }>, key: string, field: 'resolved' | 'added'): void => {
    const entry = bucket.get(key) ?? { resolved: 0, added: 0 };
    entry[field] += 1;
    bucket.set(key, entry);
  };

  const ruleCounts = new Map<string, { resolved: number; added: number }>();
  for (const finding of resolved) bump(ruleCounts, finding.ruleId, 'resolved');
  for (const finding of added) bump(ruleCounts, finding.ruleId, 'added');
  for (const [ruleId, counts] of ruleCounts) ruleMap.set(ruleId, { ruleId, ...counts });

  const fileCounts = new Map<string, { resolved: number; added: number }>();
  for (const finding of resolved) bump(fileCounts, finding.filePath, 'resolved');
  for (const finding of added) bump(fileCounts, finding.filePath, 'added');

  return {
    resolved: resolved.sort(byLocation),
    added: added.sort(byLocation),
    unchanged,
    baselineTotal: baseline.length,
    currentTotal: current.length,
    byRule: [...ruleMap.values()].sort((a, b) => b.resolved + b.added - (a.resolved + a.added)),
    byFile: [...fileCounts.entries()]
      .map(([filePath, counts]) => ({ filePath, ...counts }))
      .sort((a, b) => b.resolved + b.added - (a.resolved + a.added)),
  };
}

function byLocation(a: AnalysisFinding, b: AnalysisFinding): number {
  if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
  return a.startLine - b.startLine;
}

export const SEVERITY_ORDER: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, UNKNOWN: 3 };

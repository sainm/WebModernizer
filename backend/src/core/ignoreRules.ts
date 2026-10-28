import type { AnalysisFinding, IgnoreRule } from '../model/types.js';

/**
 * Converts a project path pattern into a regular expression.
 *
 * Supported syntax is deliberately small so the behaviour is predictable:
 *   `*`  matches within one path segment      js/*.js   -> js/app.js, not js/lib/app.js
 *   `**` matches across segments              **\/*.js  -> js/app.js and js/lib/app.js
 *   `?`  matches a single character
 * Everything else is literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` also matches nothing, so `**/*.js` covers a file at the project root.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const regexp = globToRegExp(pattern);
  cache.set(pattern, regexp);
  return regexp;
}

export function pathMatches(pattern: string | null, filePath: string): boolean {
  if (!pattern) return true;
  return compiled(pattern).test(filePath);
}

/** Everything matching needs from a rule; keeps the counter independent of persistence fields. */
export type IgnoreRuleScope = Pick<IgnoreRule, 'ruleId' | 'pathPattern' | 'enabled'>;

export interface IgnoreMatch {
  rule: IgnoreRuleScope;
  reason: string;
}

/**
 * Returns the first enabled rule that covers this finding, or null.
 * A rule with no ruleId covers every rule; a rule with no path pattern covers every file.
 */
export function findIgnoreMatch(
  finding: Pick<AnalysisFinding, 'ruleId' | 'filePath'>,
  rules: Array<IgnoreRuleScope & { reason?: string }>,
): IgnoreMatch | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.ruleId && rule.ruleId !== finding.ruleId) continue;
    if (!pathMatches(rule.pathPattern, finding.filePath)) continue;
    return { rule, reason: rule.reason ?? '' };
  }
  return null;
}

/** Prefix that marks a status note as written by the ignore-rule engine. */
export const IGNORE_NOTE_PREFIX = 'Ignored by project rule';

export function ignoreNote(rule: IgnoreRuleScope, reason: string): string {
  return `${IGNORE_NOTE_PREFIX} (${describeIgnoreRule(rule)}): ${reason}`;
}

/** True when this finding was silenced by a rule (not by a human). */
export function isIgnoredByRule(finding: Pick<AnalysisFinding, 'status' | 'statusNote'>): boolean {
  return finding.status === 'IGNORED' && (finding.statusNote ?? '').startsWith(IGNORE_NOTE_PREFIX);
}

/** Human-readable form used in the finding status note and in reports. */
export function describeIgnoreRule(rule: IgnoreRuleScope): string {
  const target = rule.ruleId ?? 'any rule';
  const scope = rule.pathPattern ?? 'any file';
  return `${target} · ${scope}`;
}

export interface IgnoreImpact {
  /** Findings the rule would silence. */
  matched: number;
  /** Subset that is already IGNORED, so the rule changes nothing for them. */
  alreadyIgnored: number;
  /** New IGNORED findings the rule would add on the next scan. */
  newlyIgnored: number;
  /** Per-rule breakdown, biggest first — shows when a path-only rule is too broad. */
  byRule: Array<{ ruleId: string; count: number }>;
}

/**
 * Answers "how much would this rule silence?" against an existing scan, so the decision
 * to ignore is made with numbers instead of after the fact.
 */
export function countIgnoreMatches(
  findings: Array<Pick<AnalysisFinding, 'ruleId' | 'filePath' | 'status'>>,
  candidate: IgnoreRuleScope,
): IgnoreImpact {
  const counts = new Map<string, number>();
  let matched = 0;
  let alreadyIgnored = 0;

  for (const finding of findings) {
    const hit = findIgnoreMatch(finding, [candidate]);
    if (!hit) continue;
    matched += 1;
    if (finding.status === 'IGNORED') alreadyIgnored += 1;
    counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  }

  return {
    matched,
    alreadyIgnored,
    newlyIgnored: matched - alreadyIgnored,
    byRule: [...counts.entries()]
      .map(([ruleId, count]) => ({ ruleId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

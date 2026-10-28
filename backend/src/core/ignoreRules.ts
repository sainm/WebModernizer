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

export interface IgnoreMatch {
  rule: IgnoreRule;
  reason: string;
}

/**
 * Returns the first enabled rule that covers this finding, or null.
 * A rule with no ruleId covers every rule; a rule with no path pattern covers every file.
 */
export function findIgnoreMatch(
  finding: Pick<AnalysisFinding, 'ruleId' | 'filePath'>,
  rules: IgnoreRule[],
): IgnoreMatch | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.ruleId && rule.ruleId !== finding.ruleId) continue;
    if (!pathMatches(rule.pathPattern, finding.filePath)) continue;
    return { rule, reason: rule.reason };
  }
  return null;
}

/** Human-readable form used in the finding status note and in reports. */
export function describeIgnoreRule(rule: IgnoreRule): string {
  const target = rule.ruleId ?? 'any rule';
  const scope = rule.pathPattern ?? 'any file';
  return `${target} · ${scope}`;
}

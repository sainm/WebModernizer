import type { MigrationRule } from '../../model/types.js';
import type { Rule, RuleDraft, FileContext } from '../types.js';
import { cssRules } from './cssRules.js';
import { dynamicRules } from './dynamicRules.js';
import { htmlRules } from './htmlRules.js';
import { jsRules } from './jsRules.js';

const DRAFTS: RuleDraft[] = [...jsRules, ...htmlRules, ...cssRules, ...dynamicRules];

export const RULES: Rule[] = DRAFTS.map((draft) => ({
  meta: {
    ...draft.meta,
    enabled: true,
    testStatus: draft.meta.testStatus ?? 'COVERED',
  } as MigrationRule,
  detect: draft.detect.bind(draft),
}));

export const RULE_MAP: Map<string, Rule> = new Map(RULES.map((rule) => [rule.meta.id, rule]));

// Fail fast at import time if two rules share an id; duplicate ids silently corrupt
// every downstream aggregation (dashboard counts, rule explorer, migration history).
{
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (seen.has(rule.meta.id)) {
      throw new Error(`Duplicate rule id: ${rule.meta.id}`);
    }
    seen.add(rule.meta.id);
  }
}

export function getRule(id: string): Rule | undefined {
  return RULE_MAP.get(id);
}

/** A rule is applicable when the parsed file actually contains a fragment of its language. */
export function ruleAppliesTo(rule: Rule, ctx: FileContext): boolean {
  const language = rule.meta.language;
  if (language === 'any') return true;
  if (language === 'javascript') return ctx.parsed.jsUnits.some((unit) => unit.result.ast !== null);
  // Inline style="" attributes produce no CSS unit, so HTML files must still be
  // considered: IE-era pages often put expression()/filter there.
  if (language === 'css') return ctx.parsed.cssUnits.length > 0 || Boolean(ctx.parsed.html);
  if (language === 'html') return Boolean(ctx.parsed.html);
  if (language === 'jsp') return ctx.language === 'jsp';
  return false;
}

export function ruleStats(): { total: number; byCategory: Record<string, number>; byLanguage: Record<string, number> } {
  const byCategory: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const rule of RULES) {
    byCategory[rule.meta.category] = (byCategory[rule.meta.category] ?? 0) + 1;
    const lang = rule.meta.language;
    byLanguage[lang] = (byLanguage[lang] ?? 0) + 1;
  }
  return { total: RULES.length, byCategory, byLanguage };
}

export type { Rule };

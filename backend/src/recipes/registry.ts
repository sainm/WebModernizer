import type { AnalysisFinding } from '../model/types.js';
import { RULES } from '../analysis/rules/index.js';
import { standardForMs } from '../analysis/cssStandards.js';
import { cssRecipes } from './cssRecipes.js';
import { htmlRecipes } from './htmlRecipes.js';
import { jsRecipes } from './jsRecipes.js';
import type { Recipe } from './types.js';

export const RECIPES: Recipe[] = [...jsRecipes, ...htmlRecipes, ...cssRecipes];

export const RECIPE_MAP: Map<string, Recipe> = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));

/**
 * Fingerprint of everything that can change what a scan produces. An incremental scan
 * may only reuse findings when this matches the previous scan exactly.
 */
export function ruleSignature(): string {
  const rules = RULES.map((rule) => `${rule.meta.id}@${rule.meta.version}`).sort();
  const recipes = RECIPES.map((recipe) => `${recipe.id}@${recipe.version}`).sort();
  return `${rules.join('|')}::${recipes.join('|')}`;
}

/** Rule ids that have a working recipe; the analyzer uses this to gate SAFE/CONDITIONAL levels. */
export const RECIPE_RULE_IDS: Set<string> = new Set(RECIPES.flatMap((recipe) => recipe.ruleIds));

/** Rule id -> recipe, since phase one has at most one recipe per rule. */
const RECIPE_BY_RULE: Map<string, Recipe> = new Map(
  RECIPES.flatMap((recipe) => recipe.ruleIds.map((ruleId) => [ruleId, recipe] as const)),
);

export function recipeForFinding(finding: AnalysisFinding): Recipe | null {
  return RECIPE_BY_RULE.get(finding.ruleId) ?? null;
}

export function recipeForRule(ruleId: string): Recipe | null {
  return RECIPE_BY_RULE.get(ruleId) ?? null;
}

/**
 * Rules where a mechanical rewrite exists in principle but no recipe is shipped yet.
 *
 * This is deliberately separate from MANUAL: "we could automate this later" is a very
 * different statement from "a human must decide". Collapsing both into one badge was
 * hiding real opportunities, so the UI reports the candidate count separately.
 */
export const PLANNED_RECIPES: Record<string, string> = {
  'WL-JS-011':
    'document.selection.createRange() maps to getSelection().getRangeAt(0), but that throws when the selection is empty and the following .text/.clear calls have no direct equivalent.',
  'WL-JS-005':
    'createEventObject maps to document.createEvent("Event"), yet the property assignments that follow (type, srcElement, keyCode) would be silently ignored on a real event, producing code that runs but does nothing.',
};

/** -ms- properties with different value syntax stay manual even though a recipe exists. */
export const PLANNED_DETAIL: Record<string, Record<string, string>> = {
  'WL-CSS-004': {
    '-ms-flex': 'flex: 1 is not the same as -ms-flex: 1 (IE implied different grow/shrink/basis defaults).',
    '-ms-writing-mode': 'lr-tb has no direct writing-mode equivalent; the value must be re-expressed.',
    '-ms-touch-action': 'touch-action accepts a different value grammar in places; verify per declaration.',
  },
};

export type AutomationStatus = 'IMPLEMENTED' | 'PLANNED' | 'NOT_SAFE';

/**
 * Automation status can depend on the finding, not only on the rule: WL-CSS-004 has a
 * recipe for properties whose value syntax matches, and stays a candidate for the rest.
 */
export function automationStatus(ruleId: string, detail?: Record<string, unknown>): AutomationStatus {
  if (ruleId === 'WL-CSS-004') {
    const property = typeof detail?.property === 'string' ? detail.property.toLowerCase() : '';
    // A still-functional -ms- property is neither automatable nor a lost opportunity:
    // Chromium honours it, so the right action is to leave it alone.
    if (detail?.classification === 'still-functional') return 'NOT_SAFE';
    return standardForMs(property) ? 'IMPLEMENTED' : 'PLANNED';
  }
  if (RECIPE_BY_RULE.has(ruleId)) return 'IMPLEMENTED';
  if (ruleId in PLANNED_RECIPES) return 'PLANNED';
  return 'NOT_SAFE';
}

export function automationHint(ruleId: string, detail?: Record<string, unknown>): string | null {
  const property = typeof detail?.property === 'string' ? detail.property.toLowerCase() : '';
  const perProperty = PLANNED_DETAIL[ruleId]?.[property];
  if (perProperty) return perProperty;
  return PLANNED_RECIPES[ruleId] ?? null;
}

export { RECIPE_BY_RULE };

import { describe, expect, it } from 'vitest';
import { RULES } from '../src/analysis/rules/index.js';
import { RECIPES } from '../src/recipes/registry.js';
import { analyzeText } from './helpers.js';
import { FIXTURES } from './ruleFixtures.js';

/**
 * Authoring guard for the rule registry.
 *
 * A rule that detects nothing useful, or explains the risk in one vague sentence, is worse
 * than no rule: it produces findings a human cannot act on. These checks run over the whole
 * registry, so adding a rule without a real explanation fails the build.
 */
const ID_PATTERN = /^WL-[A-Z]+-\d{3}$/;
const TAG_PATTERN = /^[a-z0-9-]+$/;

const CATEGORIES = new Set(['JS_API', 'DOM_API', 'HTML_COMPAT', 'CSS_COMPAT', 'ACTIVEX_VBSCRIPT', 'BROWSER_BEHAVIOR', 'DYNAMIC_CODE']);
const LANGUAGES = new Set(['javascript', 'html', 'css', 'jsp', 'any']);
const SEVERITIES = new Set(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
const LEVELS = new Set(['SAFE', 'CONDITIONAL', 'MANUAL', 'UNSUPPORTED']);

const PLACEHOLDERS = /\b(todo|tbd|n\/a|fixme|lorem)\b/i;

describe('rule metadata', () => {
  it('uses a consistent id format and unique ids', () => {
    const badIds = RULES.filter((rule) => !ID_PATTERN.test(rule.meta.id)).map((rule) => rule.meta.id);
    expect(badIds, `malformed rule ids: ${badIds.join(', ')}`).toEqual([]);
    expect(new Set(RULES.map((rule) => rule.meta.id)).size).toBe(RULES.length);
  });

  it('has unique, human-sized names', () => {
    const names = RULES.map((rule) => rule.meta.name.trim().toLowerCase());
    expect(new Set(names).size, 'duplicate rule names').toBe(names.length);

    const off = RULES.filter((rule) => {
      const length = rule.meta.name.trim().length;
      return length < 3 || length > 60;
    }).map((rule) => `${rule.meta.id}: ${rule.meta.name.length} chars`);
    expect(off, `names outside 3..60 chars: ${off.join(', ')}`).toEqual([]);
  });

  it('explains what the rule is and how it detects', () => {
    const thin = RULES.filter((rule) => rule.meta.description.trim().length < 40).map((rule) => rule.meta.id);
    expect(thin, `description shorter than 40 chars: ${thin.join(', ')}`).toEqual([]);

    const noBasis = RULES.filter((rule) => rule.meta.basis.trim().length < 30).map((rule) => rule.meta.id);
    expect(noBasis, `basis shorter than 30 chars: ${noBasis.join(', ')}`).toEqual([]);

    const templated = RULES.filter((rule) => PLACEHOLDERS.test(`${rule.meta.description} ${rule.meta.basis}`)).map(
      (rule) => rule.meta.id,
    );
    expect(templated, `placeholder text in: ${templated.join(', ')}`).toEqual([]);
  });

  it('keeps enum fields inside the documented sets', () => {
    for (const rule of RULES) {
      expect(CATEGORIES.has(rule.meta.category), `${rule.meta.id} category ${rule.meta.category}`).toBe(true);
      expect(LANGUAGES.has(rule.meta.language), `${rule.meta.id} language ${rule.meta.language}`).toBe(true);
      expect(SEVERITIES.has(rule.meta.defaultSeverity), `${rule.meta.id} severity`).toBe(true);
      expect(LEVELS.has(rule.meta.defaultMigrationLevel), `${rule.meta.id} level`).toBe(true);
    }
  });

  it('uses a small set of well-formed tags', () => {
    for (const rule of RULES) {
      expect(rule.meta.tags.length, `${rule.meta.id} has no tags`).toBeGreaterThan(0);
      expect(rule.meta.tags.length, `${rule.meta.id} has too many tags`).toBeLessThanOrEqual(5);
      expect(new Set(rule.meta.tags).size, `${rule.meta.id} repeats a tag`).toBe(rule.meta.tags.length);
      for (const tag of rule.meta.tags) expect(TAG_PATTERN.test(tag), `${rule.meta.id} tag "${tag}"`).toBe(true);
    }
  });

  it('only claims coverage for a rule that has a fixture', () => {
    const fixtures = new Set(FIXTURES.map((fixture) => fixture.id));
    const claims = RULES.filter((rule) => rule.meta.testStatus === 'COVERED' && !fixtures.has(rule.meta.id)).map(
      (rule) => rule.meta.id,
    );
    expect(claims, `rules claiming COVERED without a fixture: ${claims.join(', ')}`).toEqual([]);
  });

  it('points every recipe id at a recipe that serves that rule', () => {
    const byRule = new Map<string, string[]>();
    for (const recipe of RECIPES) {
      for (const ruleId of recipe.ruleIds) {
        const list = byRule.get(ruleId) ?? [];
        list.push(recipe.id);
        byRule.set(ruleId, list);
      }
    }
    for (const rule of RULES) {
      if (!rule.meta.recipeId) continue;
      expect(byRule.get(rule.meta.id), `${rule.meta.id} declares ${rule.meta.recipeId}`).toContain(rule.meta.recipeId);
    }
  });
});

describe('rule output quality', () => {
  it('writes an actionable risk and recommendation for every fixture', () => {
    const thin: string[] = [];
    for (const fixture of FIXTURES) {
      const { findings } = analyzeText(fixture.file, fixture.code);
      const hits = findings.filter((finding) => finding.ruleId === fixture.id);
      if (hits.length === 0) {
        thin.push(`${fixture.id}: no finding produced`);
        continue;
      }
      for (const finding of hits) {
        if (finding.risk.trim().length < 80) thin.push(`${fixture.id}: risk is ${finding.risk.trim().length} chars`);
        if (finding.recommendation.trim().length < 60) thin.push(`${fixture.id}: recommendation is ${finding.recommendation.trim().length} chars`);
        if (finding.message.trim().length < 12) thin.push(`${fixture.id}: message is too short`);
        if (PLACEHOLDERS.test(`${finding.risk} ${finding.recommendation}`)) thin.push(`${fixture.id}: placeholder text`);
      }
    }
    expect([...new Set(thin)], `weak finding text: ${[...new Set(thin)].join(' | ')}`).toEqual([]);
  });

  it('always fills the evidence triple', () => {
    const empty: string[] = [];
    for (const fixture of FIXTURES) {
      const { findings } = analyzeText(fixture.file, fixture.code);
      for (const finding of findings.filter((item) => item.ruleId === fixture.id)) {
        if (!finding.evidence.kind) empty.push(`${fixture.id}: evidence.kind`);
        if (!finding.evidence.matched.trim()) empty.push(`${fixture.id}: evidence.matched`);
        if (Object.keys(finding.evidence.detail).length === 0) empty.push(`${fixture.id}: evidence.detail`);
      }
    }
    expect([...new Set(empty)]).toEqual([]);
  });
});

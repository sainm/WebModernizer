import { describe, expect, it } from 'vitest';
import { analyzeParsedFile } from '../src/analysis/engine.js';
import { applyEdits } from '../src/core/diff.js';
import { makeSourceFile, parseSourceFile } from '../src/parser/index.js';
import { RECIPE_RULE_IDS, recipeForRule } from '../src/recipes/registry.js';
import type { AnalysisFinding } from '../src/model/types.js';

function analyze(relPath: string, code: string): AnalysisFinding[] {
  const parsed = parseSourceFile(makeSourceFile('/project', relPath, `/project/${relPath}`, code));
  return analyzeParsedFile(parsed, { scanTaskId: 'test', recipeRuleIds: RECIPE_RULE_IDS });
}

function transform(relPath: string, code: string, ruleId: string) {
  const parsed = parseSourceFile(makeSourceFile('/project', relPath, `/project/${relPath}`, code));
  const findings = analyzeParsedFile(parsed, { scanTaskId: 'test', recipeRuleIds: RECIPE_RULE_IDS });
  const finding = findings.find((item) => item.ruleId === ruleId);
  const recipe = recipeForRule(ruleId);
  if (!finding || !recipe) return { finding, preconditions: null, after: null };
  const context = { text: code, parsed };
  const preconditions = recipe.preconditions(finding, context);
  const edits = recipe.plan(finding, context);
  const after = edits ? applyEdits(code, edits) : null;
  return { finding, preconditions, after };
}

function count(relPath: string, code: string, ruleId: string): number {
  return analyze(relPath, code).filter((finding) => finding.ruleId === ruleId).length;
}

describe('CSS IE hack removal', () => {
  it('deletes a star hack that owns its line', () => {
    const code = ['.page {', '  width: 980px;', '  *width: 960px;', '}'].join('\n');
    const result = transform('r.css', code, 'WL-CSS-005');
    expect(result.preconditions?.ok).toBe(true);
    expect(result.after).toBe(['.page {', '  width: 980px;', '}'].join('\n'));
    expect(count('r.css', result.after as string, 'WL-CSS-005')).toBe(0);
  });

  it('deletes a value hack and keeps the neighbouring declaration', () => {
    const code = ['.a {', '  width: 96px;', '  width: 104px\\9;', '}'].join('\n');
    const result = transform('r.css', code, 'WL-CSS-005');
    expect(result.preconditions?.ok).toBe(true);
    expect(result.after).not.toContain('104px');
    expect(result.after).toContain('width: 96px;');
    expect(count('r.css', result.after as string, 'WL-CSS-005')).toBe(0);
  });

  it('cuts only the target when several declarations share a line', () => {
    const code = '.a { color: red; *zoom: 1; height: 10px; }';
    const result = transform('r.css', code, 'WL-CSS-005');
    expect(result.preconditions?.ok).toBe(true);
    expect(result.after).toBe('.a { color: red; height: 10px; }');
  });

  it('refuses hacks that come from an inline style attribute', () => {
    // The whole attribute value is analyzed as one pseudo-declaration; deleting that
    // range would wipe the entire attribute, so the recipe must decline.
    const code = '<html><body><div style="*zoom: 1; color: red;">x</div></body></html>';
    const result = transform('r.html', code, 'WL-CSS-005');
    expect(result.finding).toBeDefined();
    expect(result.preconditions?.ok).toBe(false);
  });
});

describe('-ms- property rename', () => {
  it('renames a property whose value syntax is identical', () => {
    const code = ['.line {', '  -ms-transform: translateZ(0);', '}'].join('\n');
    const result = transform('r.css', code, 'WL-CSS-004');
    expect(result.preconditions?.ok).toBe(true);
    expect(result.after).toContain('  transform: translateZ(0);');
    expect(result.after).not.toContain('-ms-transform');
    expect(count('r.css', result.after as string, 'WL-CSS-004')).toBe(0);
  });

  it('keeps !important and formatting untouched', () => {
    const code = '.a {\n  -ms-user-select: none !important;\n}';
    const result = transform('r.css', code, 'WL-CSS-004');
    expect(result.after).toContain('  user-select: none !important;');
  });

  it('refuses properties whose value semantics differ', () => {
    for (const code of ['.a {\n  -ms-flex: 1;\n}', '.a {\n  -ms-writing-mode: lr-tb;\n}']) {
      const result = transform('r.css', code, 'WL-CSS-004');
      expect(result.finding, code).toBeDefined();
      expect(result.preconditions?.ok, code).toBe(false);
    }
  });

  it('refuses to create a duplicate declaration in the same rule', () => {
    const code = '.a {\n  transform: none;\n  -ms-transform: translateZ(0);\n}';
    const result = transform('r.css', code, 'WL-CSS-004');
    expect(result.preconditions?.ok).toBe(false);
    expect(result.preconditions?.reasons.join(' ')).toMatch(/already declared/);
  });

  it('leaves the still-functional -ms- properties alone', () => {
    // -ms-overflow-style is honoured by Chromium, so it is reported as POSSIBLE and
    // must not be offered for renaming.
    const code = '.a {\n  -ms-overflow-style: scrollbar;\n}';
    const result = transform('r.css', code, 'WL-CSS-004');
    expect(result.finding?.severity).toBe('LOW');
    expect(result.preconditions?.ok).toBe(false);
  });
});

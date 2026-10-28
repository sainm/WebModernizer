import { describe, expect, it } from 'vitest';
import { analyzeParsedFile } from '../src/analysis/engine.js';
import { RULES } from '../src/analysis/rules/index.js';
import { applyEdits } from '../src/core/diff.js';
import { makeSourceFile, parseSourceFile } from '../src/parser/index.js';
import { RECIPE_RULE_IDS, automationStatus, recipeForRule } from '../src/recipes/registry.js';
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
  if (!finding || !recipe) return { finding, recipe, preconditions: null, after: null };
  const context = { text: code, parsed };
  const preconditions = recipe.preconditions(finding, context);
  const edits = recipe.plan(finding, context);
  const after = edits ? applyEdits(code, edits) : null;
  return { finding, recipe, preconditions, after };
}

describe('recipes added after the first review', () => {
  it('removes the obsolete script language attribute and leaves the block intact', () => {
    const code = '<html><head><script language="JavaScript" src="a.js"></script></head></html>';
    const result = transform('r.html', code, 'WL-HTML-003');
    expect(result.preconditions?.ok).toBe(true);
    expect(result.after).not.toContain('language=');
    expect(result.after).toContain('<script src="a.js">');
    expect(analyze('r.html', result.after as string).filter((f) => f.ruleId === 'WL-HTML-003')).toHaveLength(0);
  });

  it('drops the X-UA-Compatible meta tag without leaving a blank line', () => {
    const code = ['<html>', '<head>', '  <meta http-equiv="X-UA-Compatible" content="IE=EmulateIE7" />', '  <title>t</title>', '</head>', '</html>'].join('\n');
    const result = transform('r.html', code, 'WL-HTML-008');
    expect(result.preconditions?.ok).toBe(true);
    expect(result.after).not.toContain('X-UA-Compatible');
    expect(result.after?.split('\n')).toHaveLength(code.split('\n').length - 1);
    expect(result.after).not.toMatch(/\n\s*\n\s*\n/);
    expect(analyze('r.html', result.after as string).filter((f) => f.ruleId === 'WL-HTML-008')).toHaveLength(0);
  });

  it('rewrites fireEvent into dispatchEvent with a real event object', () => {
    const code = 'var el = document.getElementById("x");\nel.fireEvent("onclick");\n';
    const result = transform('r.js', code, 'WL-DOM-001');
    expect(result.preconditions?.ok).toBe(true);
    expect(result.after).toContain('el.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }))');
    expect(analyze('r.js', result.after as string).filter((f) => f.ruleId === 'WL-DOM-001')).toHaveLength(0);
  });

  it('rewrites execScript into an indirect eval that keeps global scope', () => {
    const code = 'window.execScript("var a = 1;");\n';
    const result = transform('r.js', code, 'WL-JS-014');
    expect(result.preconditions?.ok).toBe(true);
    expect(result.after).toBe('(0, eval)("var a = 1;");\n');
    expect(analyze('r.js', result.after as string).filter((f) => f.ruleId === 'WL-JS-014')).toHaveLength(0);
  });

  it('refuses the shapes the recipes cannot prove', () => {
    // fireEvent with a hand-built second argument carries payload the rewrite would lose.
    const fire = transform('r.js', 'el.fireEvent("onclick", myEvent);\n', 'WL-DOM-001');
    expect(fire.preconditions?.ok).toBe(false);
    expect(fire.finding?.migrationLevel).toBe('MANUAL');

    // execScript with a language argument is not a plain string evaluation.
    const exec = transform('r.js', 'window.execScript(code, "JScript");\n', 'WL-JS-014');
    expect(exec.preconditions?.ok).toBe(false);
    expect(exec.finding?.migrationLevel).toBe('MANUAL');

    // A VBScript block must not lose its language attribute: that would change nothing.
    const vb = transform('r.html', '<html><body><script language="VBScript">Sub A()\nEnd Sub</script></body></html>', 'WL-HTML-003');
    expect(vb.finding).toBeUndefined();
  });

  it('distinguishes implemented, planned and genuinely manual automation', () => {
    expect(automationStatus('WL-HTML-003')).toBe('IMPLEMENTED');
    expect(automationStatus('WL-CSS-005')).toBe('IMPLEMENTED');
    // -ms-flex has no standard equivalent with the same value syntax.
    expect(automationStatus('WL-CSS-004', { property: '-ms-flex', classification: 'obsolete' })).toBe('PLANNED');
    expect(automationStatus('WL-CSS-004', { property: '-ms-transform', classification: 'obsolete' })).toBe('IMPLEMENTED');
    expect(automationStatus('WL-CSS-004', { property: '-ms-overflow-style', classification: 'still-functional' })).toBe('NOT_SAFE');
    expect(automationStatus('WL-JS-003')).toBe('NOT_SAFE');
  });

  it('only claims a recipe for a rule that exists', () => {
    const ruleIds = new Set(RULES.map((rule) => rule.meta.id));
    const orphans = [...RECIPE_RULE_IDS].filter((id) => !ruleIds.has(id));
    expect(orphans).toEqual([]);
  });

  it('keeps every shipped recipe reachable from its rule metadata', () => {
    const mismatched = RULES.filter((rule) => rule.meta.recipeId && recipeForRule(rule.meta.id)?.id !== rule.meta.recipeId);
    expect(mismatched.map((rule) => rule.meta.id)).toEqual([]);
  });
});

describe('navigation and computed style rules', () => {
  it('does not mistake a framework router for the IE navigation call', () => {
    const code = ['router.navigate("/orders/1");', 'this.$router.navigate(target);'].join('\n');
    const findings = analyze('app.js', code);
    expect(findings.filter((finding) => finding.ruleId === 'WL-JS-016')).toHaveLength(0);
  });

  it('reports the window-level call and rewrites it to location.assign', () => {
    const code = 'window.navigate("/orders/1");\n';
    const findings = analyze('app.js', code);
    const hit = findings.find((finding) => finding.ruleId === 'WL-JS-016');
    expect(hit).toBeDefined();
    expect(hit?.migrationLevel).toBe('CONDITIONAL');

    const rewritten = transform('app.js', code, 'WL-JS-016');
    expect(rewritten.preconditions?.ok).toBe(true);
    expect(rewritten.after).toBe('location.assign("/orders/1");\n');
    expect(analyze('app.js', rewritten.after as string).filter((f) => f.ruleId === 'WL-JS-016')).toHaveLength(0);
  });

  it('treats a bare navigate() as the same API but refuses object methods', () => {
    const bare = transform('app.js', 'navigate("/x");\n', 'WL-JS-016');
    expect(bare.preconditions?.ok).toBe(true);
    expect(bare.after).toBe('location.assign("/x");\n');

    const router = analyze('app.js', 'router.navigate("/x");');
    expect(router.filter((f) => f.ruleId === 'WL-JS-016')).toHaveLength(0);
  });

  it('reports currentStyle with the object it was read from', () => {
    const findings = analyze('app.js', 'var h = panel.currentStyle.height;');
    const hit = findings.find((finding) => finding.ruleId === 'WL-DOM-002');
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('panel.currentStyle');
    expect(hit?.migrationLevel).toBe('MANUAL');
    expect(recipeForRule('WL-DOM-002')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { analyzeText, byRule } from './helpers.js';
import { RULE_MESSAGES, renderRuleMessage } from '../../web/src/ruleMessages.js';

function cases(source: string): ReturnType<typeof analyzeText>['findings'] {
  return analyzeText('r.js', source).findings;
}

describe('remaining IE-only detection', () => {
  it('detects event.srcUrn only on a confirmed event', () => {
    const hits = byRule(cases('function f(event) { if (event.srcUrn) { return true; } }'), 'WL-DOM-015');
    expect(hits).toHaveLength(1);
    expect(hits[0].migrationLevel).toBe('MANUAL');
    expect(hits[0].evidence.detail.objectName).toBe('event');

    const inline = analyzeText(
      'page.html',
      '<html><body><input onclick="if (event.srcUrn) return;" /></body></html>',
    ).findings;
    expect(byRule(inline, 'WL-DOM-015')).toHaveLength(1);

    const lookalikes = [
      'function f() { return window.event.srcUrn; }',
      'function f(obj) { return obj.srcUrn; }',
      'var text = "event.srcUrn";',
      '// event.srcUrn is legacy',
    ];
    for (const source of lookalikes) {
      expect(byRule(cases(source), 'WL-DOM-015'), source).toHaveLength(0);
    }
    expect(byRule(cases(lookalikes[0]), 'WL-JS-003')).toHaveLength(1);
  });

  it('detects event.recordset as unsupported data binding', () => {
    const hits = byRule(cases('function f(event) { return event.recordset; }'), 'WL-DOM-016');
    expect(hits).toHaveLength(1);
    expect(hits[0].migrationLevel).toBe('UNSUPPORTED');

    const inline = analyzeText(
      'page.html',
      '<html><body><div onclick="return event.recordset;"></div></body></html>',
    ).findings;
    expect(byRule(inline, 'WL-DOM-016')).toHaveLength(1);

    expect(byRule(cases('function f() { return window.event.recordset; }'), 'WL-DOM-016')).toHaveLength(0);
    expect(byRule(cases('function f(rs) { return rs.recordset; }'), 'WL-DOM-016')).toHaveLength(0);
  });

  it('detects setExpression and removeExpression only on style objects', () => {
    const set = byRule(cases("el.style.setExpression('width', '1px');"), 'WL-JS-020');
    expect(set).toHaveLength(1);
    expect(set[0].migrationLevel).toBe('MANUAL');
    expect(set[0].evidence.detail.methodName).toBe('setExpression');
    expect(set[0].evidence.detail.objectText).toBe('el.style');

    expect(byRule(cases("style.removeExpression('width');"), 'WL-JS-020')).toHaveLength(1);
    expect(byRule(cases("myStyle.setExpression('width', '1px');"), 'WL-JS-020')).toHaveLength(1);

    const lookalikes = [
      "el.style.setProperty('width', '1px');",
      "custom.setExpression('width', '1px');",
      "custom.removeExpression('width');",
      'var source = "el.style.setExpression(1)";',
    ];
    for (const source of lookalikes) {
      expect(byRule(cases(source), 'WL-JS-020'), source).toHaveLength(0);
    }
  });

  it('renders zh and ja summaries without leaving placeholders', () => {
    const sources: Array<[string, string]> = [
      ['WL-DOM-015', 'function f(event) { return event.srcUrn; }'],
      ['WL-DOM-016', 'function f(event) { return event.recordset; }'],
      ['WL-JS-020', "el.style.setExpression('width', '1px');"],
    ];
    for (const [ruleId, source] of sources) {
      const finding = byRule(cases(source), ruleId)[0];
      expect(finding, ruleId).toBeDefined();
      for (const locale of ['zh', 'ja'] as const) {
        const template = RULE_MESSAGES[locale][finding.messageKey];
        expect(template, `${ruleId} ${locale}`).toBeDefined();
        expect(renderRuleMessage(template, finding.messageParams), `${ruleId} ${locale}`).not.toBeNull();
      }
    }
  });
});

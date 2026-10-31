import { describe, expect, it } from 'vitest';
import { analyzeText, byRule } from './helpers.js';

const NEW_RULES = [
  'WL-DOM-005',
  'WL-DOM-006',
  'WL-DOM-007',
  'WL-DOM-008',
  'WL-DOM-009',
  'WL-DOM-010',
  'WL-BEH-003',
  'WL-BEH-004',
];

describe('removed IE API rules', () => {
  it('does not report API names that only appear in comments or string literals', () => {
    const { findings } = analyzeText(
      'r.js',
      [
        '// el.runtimeStyle; document.createStyleSheet(); window.showHelp(); document.recalc(); el.setCapture();',
        'var text = "document.frames window.createPopup event.toElement event.fromElement";',
      ].join('\n'),
    );
    for (const ruleId of NEW_RULES) expect(byRule(findings, ruleId), ruleId).toHaveLength(0);
  });

  it('does not mistake lookalike members for the IE APIs', () => {
    const { findings } = analyzeText(
      'r.js',
      [
        'var a = obj.toElement;',
        'var b = custom.showHelp("local");',
        'var c = window.frames;',
        'function f(event) { return event.relatedTarget; }',
      ].join('\n'),
    );
    expect(byRule(findings, 'WL-DOM-008')).toHaveLength(0);
    expect(byRule(findings, 'WL-BEH-003')).toHaveLength(0);
    expect(byRule(findings, 'WL-DOM-009')).toHaveLength(0);
  });

  it('detects the second variant that shares a rule', () => {
    const { findings } = analyzeText(
      'r.js',
      [
        'el.releaseCapture();',
        'function f(event) { return event.fromElement; }',
        'showHelp("help.htm");',
        'createPopup();',
      ].join('\n'),
    );
    expect(byRule(findings, 'WL-DOM-007')).toHaveLength(1);
    expect(byRule(findings, 'WL-DOM-008')).toHaveLength(1);
    expect(byRule(findings, 'WL-BEH-003')).toHaveLength(1);
    expect(byRule(findings, 'WL-BEH-004')).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { analyzeText, byRule } from './helpers.js';

const NEW_RULES = ['WL-HTML-010', 'WL-DOM-011', 'WL-DOM-012', 'WL-DOM-013', 'WL-DOM-014', 'WL-BEH-005'];

describe('remaining IE-only rules', () => {
  it('does not report names that only appear in comments or strings', () => {
    const { findings } = analyzeText(
      'r.js',
      [
        '// event.propertyName; el.addBehavior(); document.namespaces; el.styleSheet; window.offscreenBuffering;',
        'var text = "onpropertychange propertyName addBehavior namespaces styleSheet offscreenBuffering";',
      ].join('\n'),
    );
    for (const ruleId of NEW_RULES) expect(byRule(findings, ruleId), ruleId).toHaveLength(0);
  });

  it('does not mistake lookalike members for the guarded APIs', () => {
    const { findings } = analyzeText(
      'r.js',
      ['var a = record.propertyName;', 'var b = obj.namespaces;', 'var c = other.offscreenBuffering;'].join('\n'),
    );
    expect(byRule(findings, 'WL-DOM-011')).toHaveLength(0);
    expect(byRule(findings, 'WL-DOM-013')).toHaveLength(0);
    expect(byRule(findings, 'WL-BEH-005')).toHaveLength(0);
  });

  it('does not double-report styleSheet.rules', () => {
    const { findings } = analyzeText('r.js', 'var x = el.styleSheet.rules[0];');
    expect(byRule(findings, 'WL-DOM-003')).toHaveLength(1);
    expect(byRule(findings, 'WL-DOM-014')).toHaveLength(0);
  });

  it('detects the second variant of propertychange and addBehavior', () => {
    const { findings } = analyzeText(
      'r.js',
      ['el.onpropertychange = handler;', 'el.removeBehavior("#default#userData");'].join('\n'),
    );
    expect(byRule(findings, 'WL-DOM-011').some((finding) => finding.messageKey.endsWith('.onpropertychange'))).toBe(true);
    expect(byRule(findings, 'WL-DOM-012').some((finding) => finding.message.includes('removeBehavior'))).toBe(true);
  });

  it('does not report an onpropertychange attribute inside a comment', () => {
    const { findings } = analyzeText(
      'r.html',
      '<html><body><!-- <div onpropertychange="mark()"></div> --></body></html>',
    );
    expect(byRule(findings, 'WL-HTML-010')).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { analyzeText, byRule, positionOf } from './helpers.js';

describe('JavaScript IE API rules', () => {
  it('detects attachEvent as a conditional migration', () => {
    const code = ['var el = document.getElementById("x");', 'el.attachEvent("onclick", handler);'].join('\n');
    const { findings } = analyzeText('js/a.js', code);
    const hits = byRule(findings, 'WL-JS-001');
    expect(hits).toHaveLength(1);
    expect(hits[0].migrationLevel).toBe('CONDITIONAL');
    expect(hits[0].severity).toBe('HIGH');
    expect(hits[0].evidence.detail.eventName).toBe('onclick');
    expect(hits[0].startLine).toBe(2);
  });

  it('never matches comments or string literals with the same text', () => {
    // The exact decoy from the specification.
    const code = [
      '// element.attachEvent("onclick", handler);',
      "const example = 'attachEvent is deprecated';",
      '/* another attachEvent("onclick", handler) mention */',
      'var label = "detachEvent and srcElement are legacy";',
    ].join('\n');
    const { findings } = analyzeText('js/decoy.js', code);
    expect(findings).toHaveLength(0);
  });

  it('marks attachEvent as MANUAL when the event name is not a literal', () => {
    const code = 'el.attachEvent(eventName, handler);';
    const { findings } = analyzeText('js/b.js', code);
    const hits = byRule(findings, 'WL-JS-001');
    expect(hits).toHaveLength(1);
    expect(hits[0].migrationLevel).toBe('MANUAL');
  });

  it('accepts srcElement only when the object is an event parameter', () => {
    const safe = [
      'function onClick(event) {',
      '  var target = event.srcElement;',
      '  return target.id;',
      '}',
    ].join('\n');
    const safeHits = byRule(analyzeText('js/c.js', safe).findings, 'WL-JS-006');
    expect(safeHits).toHaveLength(1);
    expect(safeHits[0].migrationLevel).toBe('SAFE');
    expect(safeHits[0].confidence).toBe('CONFIRMED');

    const unsafe = 'var node = config.srcElement;';
    const unsafeHits = byRule(analyzeText('js/d.js', unsafe).findings, 'WL-JS-006');
    expect(unsafeHits).toHaveLength(1);
    expect(unsafeHits[0].migrationLevel).toBe('MANUAL');
    expect(unsafeHits[0].confidence).toBe('POSSIBLE');
  });

  it('reports window.event.srcElement once, under the window.event rule', () => {
    const code = 'function go() { return window.event.srcElement; }';
    const { findings } = analyzeText('js/e.js', code);
    expect(byRule(findings, 'WL-JS-003')).toHaveLength(1);
    expect(byRule(findings, 'WL-JS-006')).toHaveLength(0);
  });

  it('keeps returnValue as conditional and cancelBubble as safe', () => {
    const code = [
      'function onSubmit(event) {',
      '  event.returnValue = false;',
      '  event.cancelBubble = true;',
      '}',
    ].join('\n');
    const { findings } = analyzeText('js/f.js', code);
    expect(byRule(findings, 'WL-JS-007')[0].migrationLevel).toBe('CONDITIONAL');
    expect(byRule(findings, 'WL-JS-008')[0].migrationLevel).toBe('SAFE');
  });

  it('reports ActiveX and VBScript-oriented APIs as unsupported', () => {
    const code = [
      'var shell = new ActiveXObject("WScript.Shell");',
      'document.selection.createRange();',
      'window.clipboardData.setData("Text", "x");',
      'window.execScript("var a=1");',
    ].join('\n');
    const { findings } = analyzeText('js/g.js', code);
    expect(byRule(findings, 'WL-JS-013')[0].migrationLevel).toBe('UNSUPPORTED');
    expect(byRule(findings, 'WL-JS-011')[0].severity).toBe('HIGH');
    expect(byRule(findings, 'WL-JS-012')[0].migrationLevel).toBe('UNSUPPORTED');
    expect(byRule(findings, 'WL-JS-014')).toHaveLength(1);
  });

  it('detects conditional compilation directives', () => {
    const code = ['/*@cc_on', 'var v = @_jscript_version;', '@*/'].join('\n');
    const { findings } = analyzeText('js/h.js', code);
    const hits = byRule(findings, 'WL-JS-015');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].migrationLevel).toBe('UNSUPPORTED');
  });

  it('detects UA sniffing in strings and regex literals', () => {
    const code = [
      'var ua = navigator.userAgent;',
      'var isIe = ua.indexOf("MSIE 8.0") >= 0;',
      'var isOld = /MSIE (\\d+\\.\\d+);/.test(ua);',
    ].join('\n');
    const { findings } = analyzeText('js/i.js', code);
    const hits = byRule(findings, 'WL-BEH-001');
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.evidence.kind).sort()).toEqual(['RegExpLiteral', 'StringLiteral']);
  });

  it('reports exact line and column inside a multi-line function', () => {
    const code = [
      'function outer() {',
      '  if (true) {',
      '    document.getElementById("x").attachEvent("onclick", fn);',
      '  }',
      '}',
    ].join('\n');
    const { findings } = analyzeText('js/j.js', code);
    const expected = positionOf(code, 'document.getElementById("x").attachEvent');
    expect(findings[0].startLine).toBe(expected.line);
    expect(findings[0].startColumn).toBe(expected.column);
  });
});

describe('CSS IE compatibility rules', () => {
  it('separates obsolete -ms- properties from ones Chromium still honors', () => {
    const css = [
      '.a { -ms-flex: 1; }',
      '.b { -ms-overflow-style: scrollbar; }',
      '.c { -ms-high-contrast: active; }',
    ].join('\n');
    const { findings } = analyzeText('css/a.css', css);
    const hits = byRule(findings, 'WL-CSS-004');
    expect(hits).toHaveLength(3);
    const flex = hits.find((hit) => hit.evidence.detail.property === '-ms-flex');
    const overflow = hits.find((hit) => hit.evidence.detail.property === '-ms-overflow-style');
    expect(flex?.severity).toBe('MEDIUM');
    expect(flex?.confidence).toBe('CONFIRMED');
    expect(overflow?.severity).toBe('LOW');
    expect(overflow?.confidence).toBe('POSSIBLE');
  });

  it('detects expression, behavior and IE filters', () => {
    const css = [
      '.a { width: expression(document.body.clientWidth - 10); }',
      '.b { behavior: url(#default#time2); }',
      '.c { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=#fff); }',
      '.d { filter: alpha(opacity=50); }',
    ].join('\n');
    const { findings } = analyzeText('css/b.css', css);
    expect(byRule(findings, 'WL-CSS-001')[0].severity).toBe('HIGH');
    expect(byRule(findings, 'WL-CSS-002')[0].migrationLevel).toBe('UNSUPPORTED');
    expect(byRule(findings, 'WL-CSS-003')).toHaveLength(2);
  });

  it('detects star/underscore and value hacks, including inline styles', () => {
    const css = ['.a { *zoom: 1; _height: 10px; color: red\\9; }'].join('\n');
    const { findings } = analyzeText('css/c.css', css);
    expect(byRule(findings, 'WL-CSS-005').length).toBeGreaterThanOrEqual(2);

    const html = '<div style="width: expression(1); *height: 10px;">x</div>';
    const inline = analyzeText('a.html', html).findings;
    expect(byRule(inline, 'WL-CSS-001')).toHaveLength(1);
    expect(byRule(inline, 'WL-CSS-005')).toHaveLength(1);
  });

  it('flags zoom as possible rather than confirmed', () => {
    const { findings } = analyzeText('css/d.css', '.a { zoom: 1; }');
    const hits = byRule(findings, 'WL-CSS-006');
    expect(hits).toHaveLength(1);
    expect(hits[0].confidence).toBe('POSSIBLE');
  });
});

describe('HTML compatibility rules', () => {
  it('raises severity when a conditional comment loads assets', () => {
    const withAssets = '<html><head><!--[if lt IE 9]><script src="ie.js"></script><![endif]--></head></html>';
    const plain = '<html><body><!--[if IE]><p>IE only</p><![endif]--></body></html>';
    expect(byRule(analyzeText('a.html', withAssets).findings, 'WL-HTML-001')[0].severity).toBe('HIGH');
    expect(byRule(analyzeText('b.html', plain).findings, 'WL-HTML-001')[0].severity).toBe('MEDIUM');
  });

  it('detects legacy elements, ActiveX objects and data islands', () => {
    const html = [
      '<html><body>',
      '<marquee>notice</marquee>',
      '<object classid="clsid:22D6F312-B0F6-11D0-94AB-0080C74C7E95"></object>',
      '<xml id="data"><items /></xml>',
      '<img src="a.gif" dynsrc="a.avi" lowsrc="b.gif" />',
      '</body></html>',
    ].join('\n');
    const { findings } = analyzeText('c.html', html);
    expect(byRule(findings, 'WL-HTML-002')).toHaveLength(1);
    expect(byRule(findings, 'WL-HTML-005')[0].migrationLevel).toBe('UNSUPPORTED');
    expect(byRule(findings, 'WL-HTML-007')).toHaveLength(1);
    expect(byRule(findings, 'WL-HTML-006')).toHaveLength(2);
  });

  it('detects VBScript blocks and the IE-only script for/event binding', () => {
    const html = [
      '<html><body>',
      '<script language="VBScript">',
      '  Sub Go()',
      '  End Sub',
      '</script>',
      '<script for="window" event="onload">init();</script>',
      '</body></html>',
    ].join('\n');
    const { findings } = analyzeText('d.html', html);
    expect(byRule(findings, 'WL-HTML-004')[0].severity).toBe('HIGH');
    expect(byRule(findings, 'WL-HTML-009')).toHaveLength(1);
  });
});

describe('JSP handling', () => {
  const jsp = [
    '<%@ page contentType="text/html; charset=UTF-8" %>',
    '<html><body>',
    '<script type="text/javascript">',
    '  function init() {',
    '    var el = document.getElementById("x");',
    '    el.attachEvent("onclick", handler);',
    '  }',
    '  function cancel(event) {',
    '    event.returnValue = <%= "false" %>;',
    '  }',
    '</script>',
    '</body></html>',
  ].join('\n');

  it('maps embedded script findings back to the .jsp line', () => {
    const { findings } = analyzeText('page/test.jsp', jsp);
    const attach = byRule(findings, 'WL-JS-001')[0];
    expect(attach.filePath).toBe('page/test.jsp');
    expect(attach.startLine).toBe(6);
    expect(attach.migrationLevel).toBe('CONDITIONAL');
  });

  it('downgrades findings that intersect a dynamic region', () => {
    const { findings } = analyzeText('page/test.jsp', jsp);
    const returnValue = byRule(findings, 'WL-JS-007')[0];
    expect(returnValue.migrationLevel).toBe('MANUAL');
    expect(returnValue.confidence).toBe('NEEDS_ANALYSIS');
    expect(returnValue.evidence.touchesDynamicRegion).toBe(true);
  });

  it('reports dynamic regions inside analyzed blocks', () => {
    const { findings } = analyzeText('page/test.jsp', jsp);
    const dynamic = byRule(findings, 'WL-JSP-001');
    expect(dynamic.length).toBeGreaterThanOrEqual(1);
    expect(dynamic[0].category).toBe('DYNAMIC_CODE');
  });
});

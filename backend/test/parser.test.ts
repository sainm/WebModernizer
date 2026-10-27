import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeJsp, intersectsRegions } from '../src/parser/jspAnalyzer.js';
import { parseSourceFile, makeSourceFile } from '../src/parser/index.js';
import { parseJavaScriptFragment, memberPath, walkJs } from '../src/parser/jsParser.js';
import { decodeBuffer, DEFAULT_ENCODINGS } from '../src/core/textDecode.js';
import { analyzeText, byRule } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('JSP masking', () => {
  const source = [
    '<%@ page pageEncoding="UTF-8" %>',
    '<div>${sessionScope.user}</div>',
    '<%-- comment with <% nested %> text --%>',
    '<% if (a) { %>',
    '  <span><%= value %></span>',
    '<% } %>',
    '<jsp:include page="x.jsp" />',
  ].join('\n');

  it('preserves length and line count', () => {
    const analysis = analyzeJsp(source);
    expect(analysis.masked.length).toBe(source.length);
    expect(analysis.masked.split('\n').length).toBe(source.split('\n').length);
  });

  it('blanks dynamic regions while keeping newlines', () => {
    const analysis = analyzeJsp(source);
    expect(analysis.masked).not.toContain('<%');
    expect(analysis.masked).not.toContain('${');
    expect(analysis.masked).not.toContain('<jsp:');
    expect(analysis.regions.map((region) => region.kind)).toEqual(
      expect.arrayContaining(['DIRECTIVE', 'EL', 'COMMENT', 'SCRIPTLET', 'EXPRESSION', 'JSP_TAG']),
    );
  });

  it('detects intersection with a region', () => {
    const analysis = analyzeJsp('var a = <%= x %>;');
    const region = analysis.regions[0];
    expect(intersectsRegions(analysis.regions, region.start, region.end)).not.toBeNull();
    expect(intersectsRegions(analysis.regions, 0, 5)).toBeNull();
  });
});

describe('offset mapping', () => {
  it('makes AST offsets file-absolute for embedded fragments', () => {
    const file = ['var a = 1;', 'function f() {', '  el.attachEvent("onclick", h);', '}'].join('\n');
    const base = file.indexOf('function f');
    const result = parseJavaScriptFragment(file.slice(base), base, 'script');
    const found: number[] = [];
    walkJs(result.ast, (node) => {
      if (node.type === 'MemberExpression' && memberPath(node) === '*.attachEvent') {
        found.push(node.start as number);
      }
    });
    expect(found).toHaveLength(1);
    expect(file.slice(found[0], found[0] + 11)).toBe('el.attachEv');
    expect(found[0]).toBeGreaterThan(base);
  });

  it('locates inline event handlers using the attribute value offset', () => {
    const html = ['<html><body>', '<div id="a" onclick = "return window.event.srcElement;">x</div>', '</body></html>'].join('\n');
    const { findings } = analyzeText('page.html', html);
    const hit = byRule(findings, 'WL-JS-003')[0];
    expect(hit.startLine).toBe(2);
    expect(html.split('\n')[1].slice(hit.startColumn - 1, hit.startColumn - 1 + 12)).toBe('window.event');
  });

  it('maps CSS declarations inside a <style> block to file offsets', () => {
    const html = ['<html><head><style>', '.a {', '  width: expression(1);', '}', '</style></head></html>'].join('\n');
    const { findings } = analyzeText('page.html', html);
    const hit = byRule(findings, 'WL-CSS-001')[0];
    expect(hit.startLine).toBe(3);
    expect(hit.language).toBe('html');
  });

  it('keeps a 1-based column for the first character of a line', () => {
    const parsed = parseSourceFile(makeSourceFile('/p', 'a.js', '/p/a.js', 'x;\nattachEvent;\n'));
    expect(parsed.index.positionAt(0)).toEqual({ line: 1, column: 1 });
    expect(parsed.index.positionAt(3)).toEqual({ line: 2, column: 1 });
  });
});

describe('text decoding', () => {
  it('does not include GBK in the default candidate list', () => {
    expect([...DEFAULT_ENCODINGS]).not.toContain('gbk');
    expect([...DEFAULT_ENCODINGS]).not.toContain('gb18030');
    expect([...DEFAULT_ENCODINGS]).toEqual(expect.arrayContaining(['utf-8', 'shift_jis', 'euc-jp']));
  });

  it('reads UTF-8 without touching it', () => {
    const buffer = Buffer.from('var a = "日本語テキスト";', 'utf8');
    const decoded = decodeBuffer(buffer);
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.text).toContain('日本語テキスト');
    expect(decoded.replacementCount).toBe(0);
  });

  it('detects Shift_JIS by content when nothing declares it', () => {
    const fixture = resolve(here, '../../examples/legacy-app/js/shift-jis-helper.js');
    const bytes = readFileSync(fixture);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
    const decoded = decodeBuffer(bytes);
    expect(decoded.encoding).toBe('shift_jis');
    expect(decoded.text).toContain('受注');
    expect(decoded.replacementCount).toBe(0);
  });

  it('honours a declared meta charset', () => {
    const html = '<html><head><meta charset="Shift_JIS"></head><body>x</body></html>';
    const decoded = decodeBuffer(Buffer.from(html, 'utf8'));
    expect(decoded.encoding).toBe('shift_jis');
    expect(decoded.source).toBe('META');
  });

  it('strips a UTF-8 BOM', () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('var a = 1;', 'utf8')]);
    const decoded = decodeBuffer(buffer);
    expect(decoded.source).toBe('BOM');
    expect(decoded.text.startsWith('var')).toBe(true);
  });

  it('decodes the Shift_JIS fixture from the example project correctly', () => {
    const fixture = resolve(here, '../../examples/legacy-app/js/shift-jis-helper.js');
    const decoded = decodeBuffer(readFileSync(fixture));
    expect(decoded.encoding).toBe('shift_jis');
    expect(decoded.text).toContain('受注画面の補助処理');
    const { findings } = analyzeText('js/shift-jis-helper.js', decoded.text);
    expect(byRule(findings, 'WL-JS-001')).toHaveLength(1);
  });
});

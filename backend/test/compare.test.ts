import { describe, expect, it } from 'vitest';
import { compareFindings, findingKey } from '../src/core/compare.js';
import type { AnalysisFinding } from '../src/model/types.js';

function finding(overrides: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    id: 'fnd_x',
    scanTaskId: 'scn_1',
    ruleId: 'WL-JS-001',
    ruleVersion: '1.0.0',
    filePath: 'js/a.js',
    language: 'javascript',
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
    startOffset: 0,
    endOffset: 9,
    category: 'JS_API',
    severity: 'HIGH',
    migrationLevel: 'CONDITIONAL',
    confidence: 'CONFIRMED',
    message: 'Calls attachEvent',
    risk: 'risk',
    recommendation: 'recommendation',
    evidence: { kind: 'CallExpression', matched: 'x', detail: {} },
    snippet: 'el.attachEvent("onclick", h)',
    status: 'DETECTED',
    statusUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('finding identity across scans', () => {
  it('ignores whitespace differences in the snippet', () => {
    const a = finding({ snippet: 'el.attachEvent("onclick",  h)' });
    const b = finding({ snippet: '  el.attachEvent("onclick", h)  ' });
    expect(findingKey(a)).toBe(findingKey(b));
  });

  it('separates different rules and files', () => {
    expect(findingKey(finding({ ruleId: 'WL-JS-001' }))).not.toBe(findingKey(finding({ ruleId: 'WL-JS-002' })));
    expect(findingKey(finding({ filePath: 'js/a.js' }))).not.toBe(findingKey(finding({ filePath: 'js/b.js' })));
  });
});

describe('scan comparison', () => {
  it('treats a line shift as unchanged', () => {
    const before = [finding({ startLine: 5, startOffset: 100 })];
    const after = [finding({ startLine: 42, startOffset: 1200 })];
    const result = compareFindings(before, after);
    expect(result.unchanged).toBe(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.added).toHaveLength(0);
  });

  it('reports a removed occurrence as resolved', () => {
    const before = [finding({ id: 'a' }), finding({ id: 'b', snippet: 'el2.attachEvent("x", h)' })];
    const after = [finding({ id: 'c' })];
    const result = compareFindings(before, after);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].id).toBe('b');
    expect(result.added).toHaveLength(0);
  });

  it('reports a new occurrence as added', () => {
    const before = [finding({ id: 'a' })];
    const after = [finding({ id: 'b' }), finding({ id: 'c', snippet: 'el3.attachEvent("y", h)' })];
    const result = compareFindings(before, after);
    expect(result.added).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });

  it('counts occurrences instead of deduplicating identical snippets', () => {
    const same = 'el.attachEvent("onclick", h)';
    const before = [finding({ id: '1', snippet: same }), finding({ id: '2', snippet: same }), finding({ id: '3', snippet: same })];
    const after = [finding({ id: '4', snippet: same }), finding({ id: '5', snippet: same })];
    const result = compareFindings(before, after);
    expect(result.unchanged).toBe(2);
    expect(result.resolved).toHaveLength(1);
    expect(result.added).toHaveLength(0);
  });

  it('treats a rewritten line as resolved plus added', () => {
    const before = [finding({ id: 'old', snippet: 'el.attachEvent("onclick", h)' })];
    const after = [finding({ id: 'new', ruleId: 'WL-JS-003', snippet: 'var e = window.event;' })];
    const result = compareFindings(before, after);
    expect(result.resolved.map((item) => item.id)).toEqual(['old']);
    expect(result.added.map((item) => item.id)).toEqual(['new']);
    expect(result.byRule).toEqual([
      { ruleId: 'WL-JS-001', resolved: 1, added: 0 },
      { ruleId: 'WL-JS-003', resolved: 0, added: 1 },
    ]);
  });

  it('rolls up by file and orders by activity', () => {
    const before = [
      finding({ id: 'a', filePath: 'js/a.js' }),
      finding({ id: 'b', filePath: 'css/main.css', ruleId: 'WL-CSS-005' }),
    ];
    const after = [
      finding({ id: 'c', filePath: 'css/main.css', ruleId: 'WL-CSS-005' }),
      finding({ id: 'd', filePath: 'css/main.css', ruleId: 'WL-CSS-004', snippet: '.x { -ms-flex: 1; }' }),
      finding({ id: 'e', filePath: 'css/main.css', ruleId: 'WL-CSS-004', snippet: '.y { -ms-flex: 2; }' }),
    ];
    const result = compareFindings(before, after);
    expect(result.byFile[0].filePath).toBe('css/main.css');
    expect(result.byFile[0].added).toBe(2);
    expect(result.baselineTotal).toBe(2);
    expect(result.currentTotal).toBe(3);
  });
});

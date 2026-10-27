import { describe, expect, it } from 'vitest';
import { applyEdits, diffLines, toUnifiedDiff } from '../src/core/diff.js';

describe('line diff', () => {
  it('reports additions, deletions and unchanged lines', () => {
    const before = 'a\nb\nc';
    const after = 'a\nB\nc\nd';
    const hunks = diffLines(before, after);
    expect(hunks.filter((hunk) => hunk.type === 'equal').map((hunk) => hunk.text)).toEqual(['a', 'c']);
    expect(hunks.filter((hunk) => hunk.type === 'del').map((hunk) => hunk.text)).toEqual(['b']);
    expect(hunks.filter((hunk) => hunk.type === 'add').map((hunk) => hunk.text)).toEqual(['B', 'd']);
  });

  it('produces an empty unified diff when nothing changed', () => {
    expect(toUnifiedDiff('a\nb', 'a\nb', 'f.js')).toBe('');
  });

  it('writes a unified header with context', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const after = ['1', '2', '3', 'X', '5', '6', '7', '8'].join('\n');
    const diff = toUnifiedDiff(before, after, 'src/a.js');
    expect(diff.startsWith('--- a/src/a.js')).toBe(true);
    expect(diff).toContain('+++ b/src/a.js');
    expect(diff).toContain('-4');
    expect(diff).toContain('+X');
    expect(diff).toContain('@@');
  });
});

describe('edit application', () => {
  it('applies edits from the end so offsets stay valid', () => {
    const text = 'el.attachEvent("onclick", h);';
    const result = applyEdits(text, [
      { start: text.indexOf('attachEvent'), end: text.indexOf('attachEvent') + 11, newText: 'addEventListener', ruleId: 'r', reason: '' },
      { start: text.indexOf('"onclick"'), end: text.indexOf('"onclick"') + 9, newText: '"click"', ruleId: 'r', reason: '' },
    ]);
    expect(result).toBe('el.addEventListener("click", h);');
  });

  it('rejects overlapping edits instead of corrupting the file', () => {
    const text = 'abcdef';
    expect(() =>
      applyEdits(text, [
        { start: 0, end: 4, newText: 'X', ruleId: 'r', reason: '' },
        { start: 2, end: 5, newText: 'Y', ruleId: 'r', reason: '' },
      ]),
    ).toThrow(/Overlapping/);
  });
});

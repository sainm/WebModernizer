import type { DiffHunk, TextEdit } from '../model/types.js';

/**
 * Line diff based on a trimmed LCS.
 *
 * Common prefix and suffix are stripped first, which keeps the DP table tiny for
 * the typical case (a handful of edited lines inside a large legacy file). When the
 * remaining block is still too large, the middle is emitted as a full replacement
 * rather than allocating an unbounded matrix.
 */
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text.split('\n');
}

function lcsOps(before: string[], after: string[]): Array<{ type: 'equal' | 'add' | 'del'; oldIndex: number | null; newIndex: number | null }> {
  const n = before.length;
  const m = after.length;
  const ops: Array<{ type: 'equal' | 'add' | 'del'; oldIndex: number | null; newIndex: number | null }> = [];

  if (n === 0) {
    for (let j = 0; j < m; j += 1) ops.push({ type: 'add', oldIndex: null, newIndex: j });
    return ops;
  }
  if (m === 0) {
    for (let i = 0; i < n; i += 1) ops.push({ type: 'del', oldIndex: i, newIndex: null });
    return ops;
  }

  // Trim shared prefix.
  let prefix = 0;
  while (prefix < n && prefix < m && before[prefix] === after[prefix]) {
    ops.push({ type: 'equal', oldIndex: prefix, newIndex: prefix });
    prefix += 1;
  }
  // Trim shared suffix.
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && before[n - 1 - suffix] === after[m - 1 - suffix]) {
    suffix += 1;
  }

  const bMid = before.slice(prefix, n - suffix);
  const aMid = after.slice(prefix, m - suffix);

  if (bMid.length * aMid.length > MAX_CELLS) {
    for (let i = 0; i < bMid.length; i += 1) ops.push({ type: 'del', oldIndex: prefix + i, newIndex: null });
    for (let j = 0; j < aMid.length; j += 1) ops.push({ type: 'add', oldIndex: null, newIndex: prefix + j });
  } else {
    const rows = bMid.length + 1;
    const cols = aMid.length + 1;
    const dp = new Int32Array(rows * cols);
    for (let i = bMid.length - 1; i >= 0; i -= 1) {
      for (let j = aMid.length - 1; j >= 0; j -= 1) {
        dp[i * cols + j] =
          bMid[i] === aMid[j] ? dp[(i + 1) * cols + (j + 1)] + 1 : Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < bMid.length && j < aMid.length) {
      if (bMid[i] === aMid[j]) {
        ops.push({ type: 'equal', oldIndex: prefix + i, newIndex: prefix + j });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
        ops.push({ type: 'del', oldIndex: prefix + i, newIndex: null });
        i += 1;
      } else {
        ops.push({ type: 'add', oldIndex: null, newIndex: prefix + j });
        j += 1;
      }
    }
    while (i < bMid.length) {
      ops.push({ type: 'del', oldIndex: prefix + i, newIndex: null });
      i += 1;
    }
    while (j < aMid.length) {
      ops.push({ type: 'add', oldIndex: null, newIndex: prefix + j });
      j += 1;
    }
  }

  for (let k = 0; k < suffix; k += 1) {
    ops.push({ type: 'equal', oldIndex: n - suffix + k, newIndex: m - suffix + k });
  }
  return ops;
}

export function diffLines(before: string, after: string): DiffHunk[] {
  const bLines = splitLines(before);
  const aLines = splitLines(after);
  const ops = lcsOps(bLines, aLines);
  return ops.map((op) => ({
    type: op.type,
    oldLine: op.oldIndex === null ? null : op.oldIndex + 1,
    newLine: op.newIndex === null ? null : op.newIndex + 1,
    text: op.type === 'del' ? bLines[op.oldIndex as number] : aLines[op.newIndex as number],
  }));
}

/** Unified diff with 3 lines of context, stored for audit and rendered in reports. */
export function toUnifiedDiff(before: string, after: string, filePath: string, context = 3): string {
  const hunks = diffLines(before, after);
  const changed = hunks.map((h, idx) => ({ h, idx })).filter(({ h }) => h.type !== 'equal');
  if (changed.length === 0) return '';

  const keep = new Set<number>();
  for (const { idx } of changed) {
    for (let k = idx - context; k <= idx + context; k += 1) {
      if (k >= 0 && k < hunks.length) keep.add(k);
    }
  }

  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let idx = 0;
  while (idx < hunks.length) {
    if (!keep.has(idx)) {
      idx += 1;
      continue;
    }
    const start = idx;
    while (idx < hunks.length && keep.has(idx)) idx += 1;
    const group = hunks.slice(start, idx);

    const oldStart = group.find((h) => h.oldLine !== null)?.oldLine ?? 1;
    const newStart = group.find((h) => h.newLine !== null)?.newLine ?? 1;
    const oldCount = group.filter((h) => h.oldLine !== null).length;
    const newCount = group.filter((h) => h.newLine !== null).length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const h of group) {
      const prefix = h.type === 'add' ? '+' : h.type === 'del' ? '-' : ' ';
      lines.push(`${prefix}${h.text}`);
    }
  }
  return lines.join('\n');
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    if (edit.end > lastStart) {
      throw new Error(`Overlapping edits at offset ${edit.start}`);
    }
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

/** Builds a window of source lines around a range, used for diff previews. */
export function contextWindow(text: string, startOffset: number, endOffset: number, paddingLines = 6): { before: string; after: string; startLine: number; endLine: number } {
  const before = text.slice(0, startOffset);
  const startLine = before.split('\n').length;
  const endLine = startLine + text.slice(startOffset, endOffset).split('\n').length - 1;
  const lines = text.split('\n');
  const from = Math.max(1, startLine - paddingLines);
  const to = Math.min(lines.length, endLine + paddingLines);
  return {
    before: lines.slice(from - 1, to).join('\n'),
    after: '',
    startLine: from,
    endLine: to,
  };
}

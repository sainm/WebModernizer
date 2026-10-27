/**
 * Line / column conversion.
 *
 * Every parser hands us offsets, and their column bases disagree
 * (parse5 is 1-based, Babel and PostCSS are 0-based). A single LineIndex
 * normalizes everything to 1-based line / column so findings from different
 * languages stay comparable.
 */
export class LineIndex {
  readonly text: string;
  private readonly starts: number[];

  constructor(text: string) {
    this.text = text;
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        starts.push(i + 1);
      }
    }
    this.starts = starts;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** offset -> 1-based line / column */
  positionAt(offset: number): { line: number; column: number } {
    const off = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid] <= off) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: off - this.starts[low] + 1 };
  }

  offsetAt(line: number, column: number): number {
    const start = this.lineStart(line);
    const lineEnd = line < this.starts.length ? this.starts[line] - 1 : this.text.length;
    return Math.max(start, Math.min(start + Math.max(0, column - 1), lineEnd));
  }

  lineStart(line: number): number {
    const idx = Math.max(0, Math.min(line - 1, this.starts.length - 1));
    return this.starts[idx];
  }

  lineText(line: number): string {
    if (line < 1 || line > this.lineCount) return '';
    const start = this.lineStart(line);
    const end = line < this.starts.length ? this.starts[line] - 1 : this.text.length;
    return this.text.slice(start, end).replace(/\r$/, '');
  }

  /** Extracts the inclusive line range [from, to] as context text */
  sliceLines(from: number, to: number): string {
    const a = Math.max(1, Math.min(from, to));
    const b = Math.min(this.lineCount, Math.max(from, to));
    const start = this.lineStart(a);
    const end = b < this.starts.length ? this.starts[b] - 1 : this.text.length;
    return this.text.slice(start, end);
  }
}

export interface Position {
  line: number;
  column: number;
}

export function positionToOffset(text: string, line: number, column: number): number {
  return new LineIndex(text).offsetAt(line, column);
}

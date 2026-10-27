/**
 * Legacy text decoding.
 *
 * IE-era JSP/HTML files are frequently not UTF-8. A mis-decoded file still parses,
 * but every offset we report afterwards points at the wrong column, so decoding
 * happens once, before parsing, and the chosen encoding is recorded on the file.
 *
 * Supported set: UTF-8 (with or without BOM), Shift_JIS, EUC-JP, ISO-2022-JP,
 * UTF-16LE/BE. GBK / GB18030 are intentionally NOT part of the default candidate
 * list; see docs/TECH-VALIDATION.md for the rationale and how to override it.
 */

export const DEFAULT_ENCODINGS = ['utf-8', 'shift_jis', 'euc-jp', 'iso-2022-jp', 'utf-16le', 'utf-16be'] as const;

export type DefaultEncoding = (typeof DEFAULT_ENCODINGS)[number];

export type EncodingSource = 'BOM' | 'META' | 'STRICT_UTF8' | 'HEURISTIC' | 'FALLBACK';

export interface DecodedText {
  text: string;
  encoding: string;
  source: EncodingSource;
  /** Number of U+FFFD produced while decoding; anything above 0 means data loss. */
  replacementCount: number;
  /** Confidence of the heuristic decision, 0..1 */
  confidence: number;
}

const BOMS: Array<{ bytes: number[]; encoding: string }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

function detectBom(buffer: Buffer): { encoding: string; length: number } | null {
  for (const bom of BOMS) {
    if (buffer.length < bom.bytes.length) continue;
    if (bom.bytes.every((byte, i) => buffer[i] === byte)) {
      return { encoding: bom.encoding, length: bom.bytes.length };
    }
  }
  return null;
}

/** Reads charset from the first 8 KB of the file without decoding it yet. */
function detectDeclaredCharset(buffer: Buffer): string | null {
  const head = buffer.subarray(0, 8192).toString('latin1');
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-]+)/i.exec(head) ??
    /content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_\-]+)/i.exec(head) ??
    /<%@\s*page[^>]*contentType\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_\-]+)/i.exec(head) ??
    /<%@\s*page[^>]*pageEncoding\s*=\s*["']([a-z0-9_\-]+)/i.exec(head);
  return meta ? meta[1].toLowerCase() : null;
}

function normalizeEncoding(name: string): string {
  const n = name.toLowerCase().replace(/[_\s]/g, '-');
  if (n === 'utf8') return 'utf-8';
  if (n === 'sjis' || n === 'shift-jis' || n === 'x-sjis' || n === 'ms-kanji' || n === 'windows-31j' || n === 'cp932') {
    return 'shift_jis';
  }
  if (n === 'eucjp' || n === 'x-euc-jp') return 'euc-jp';
  if (n === 'iso-2022-jp' || n === 'jis') return 'iso-2022-jp';
  if (n === 'utf-16') return 'utf-16le';
  return n;
}

export function isSupportedEncoding(name: string): boolean {
  const normalized = normalizeEncoding(name);
  if ((DEFAULT_ENCODINGS as readonly string[]).includes(normalized)) return true;
  try {
    new TextDecoder(normalized);
    return true;
  } catch {
    return false;
  }
}

function decodeWith(buffer: Buffer, encoding: string, fatal: boolean): string {
  return new TextDecoder(encoding, { fatal }).decode(buffer);
}

function countReplacement(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === '\uFFFD') count += 1;
  }
  return count;
}

/**
 * Scores a candidate decoding. Japanese text is expected to contain hiragana and
 * katakana; a wrong-but-valid decoding of the same bytes usually produces kanji
 * soup or control characters instead.
 */
function scoreDecoded(text: string): number {
  let hiragana = 0;
  let katakana = 0;
  let kanji = 0;
  let ascii = 0;
  let control = 0;
  let privateUse = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x3041 && code <= 0x309f) hiragana += 1;
    else if (code >= 0x30a1 && code <= 0x30fa) katakana += 1;
    else if (code >= 0x4e00 && code <= 0x9fff) kanji += 1;
    else if (code < 0x80) ascii += 1;
    else if (code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') control += 1;
    else if (code >= 0xe000 && code <= 0xf8ff) privateUse += 1;
  }
  const total = Math.max(1, text.length);
  // Japanese kana are the strongest signal that Shift_JIS / EUC-JP was correct.
  return (hiragana + katakana) * 3 + kanji * 0.2 + (ascii / total) * 10 - control * 5 - privateUse * 2;
}

export interface DecodeOptions {
  /** Candidate encodings tried during heuristic detection, in priority order. */
  candidates?: string[];
  /** Overrides detection entirely (project-level setting). */
  forceEncoding?: string;
}

export function decodeBuffer(buffer: Buffer, options: DecodeOptions = {}): DecodedText {
  const candidates = options.candidates?.length ? options.candidates : [...DEFAULT_ENCODINGS];

  if (options.forceEncoding) {
    const encoding = normalizeEncoding(options.forceEncoding);
    const text = decodeWith(buffer, encoding, false);
    return { text, encoding, source: 'META', replacementCount: countReplacement(text), confidence: 1 };
  }

  const bom = detectBom(buffer);
  if (bom) {
    const encoding = bom.encoding === 'utf-32le' || bom.encoding === 'utf-32be' ? 'utf-8' : bom.encoding;
    const body = bom.encoding.startsWith('utf-32') ? buffer : buffer.subarray(bom.length);
    const text = decodeWith(body, encoding, false);
    return { text, encoding, source: 'BOM', replacementCount: countReplacement(text), confidence: 1 };
  }

  const declared = detectDeclaredCharset(buffer);
  if (declared) {
    const encoding = normalizeEncoding(declared);
    if (isSupportedEncoding(encoding)) {
      try {
        const text = decodeWith(buffer, encoding, true);
        return { text, encoding, source: 'META', replacementCount: 0, confidence: 0.95 };
      } catch {
        // Declared charset contradicts the bytes; fall through to heuristic detection.
      }
    }
  }

  // Pure ASCII or valid UTF-8 is by far the most common case.
  try {
    const text = decodeWith(buffer, 'utf-8', true);
    return {
      text,
      encoding: 'utf-8',
      source: declared ? 'HEURISTIC' : 'STRICT_UTF8',
      replacementCount: 0,
      confidence: declared ? 0.8 : 1,
    };
  } catch {
    // Not valid UTF-8: try the Japanese candidates and pick the best score.
  }

  let best: { text: string; encoding: string; score: number; replacements: number } | null = null;
  for (const candidate of candidates) {
    if (candidate === 'utf-8') continue;
    const encoding = normalizeEncoding(candidate);
    if (!isSupportedEncoding(encoding)) continue;
    try {
      const text = decodeWith(buffer, encoding, true);
      const score = scoreDecoded(text);
      if (!best || score > best.score) {
        best = { text, encoding, score, replacements: 0 };
      }
    } catch {
      continue;
    }
  }

  if (best) {
    return {
      text: best.text,
      encoding: best.encoding,
      source: 'HEURISTIC',
      replacementCount: best.replacements,
      confidence: Math.min(0.9, Math.max(0.3, best.score / 100)),
    };
  }

  const fallback = decodeWith(buffer, 'utf-8', false);
  return {
    text: fallback,
    encoding: 'utf-8',
    source: 'FALLBACK',
    replacementCount: countReplacement(fallback),
    confidence: 0.1,
  };
}

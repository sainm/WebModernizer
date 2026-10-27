import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Language, ParseProblem, SourceFile } from '../model/types.js';
import { LANGUAGE_BY_EXTENSION } from '../model/types.js';
import { sha256 } from '../model/ids.js';
import { LineIndex } from './lineIndex.js';
import { parseJavaScriptFragment, type JsParseResult } from './jsParser.js';
import { parseHtml, rawAttributeValue, type HtmlDoc, type P5Node } from './htmlParser.js';
import { parseCssFragment, type CssParseResult } from './cssParser.js';
import { analyzeJsp, intersectsRegions, type DynamicRegion, type JspAnalysis } from './jspAnalyzer.js';

export interface JsUnit {
  /** Fragment source code */
  code: string;
  /** Absolute offset of the fragment inside the file */
  baseOffset: number;
  /** Fragment origin, e.g. `<script>` or an `onclick` attribute */
  container: string;
  result: JsParseResult;
  /** Whether the fragment intersects a JSP dynamic region */
  dynamic: boolean;
  dynamicRegion: DynamicRegion | null;
  startLine: number;
}

export interface CssUnit {
  code: string;
  baseOffset: number;
  container: string;
  result: CssParseResult;
  dynamic: boolean;
  dynamicRegion: DynamicRegion | null;
}

export interface ParsedFile {
  file: SourceFile;
  index: LineIndex;
  language: Language;
  /** Fragments analyzed as JavaScript, including embedded ones */
  jsUnits: JsUnit[];
  /** Fragments analyzed as CSS, including inline <style> blocks */
  cssUnits: CssUnit[];
  html: HtmlDoc | null;
  jsp: JspAnalysis | null;
  dynamicRegions: DynamicRegion[];
  problems: ParseProblem[];
  /** Whether we obtained analyzable content */
  parsed: boolean;
}

const JS_SCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
  'module',
  'text/jsx',
]);

const NON_JS_SCRIPT_TYPES = new Set(['text/vbscript', 'text/vbs', 'application/x-vbscript', 'text/template', 'text/x-template']);

export function languageOf(filePath: string): Language | null {
  return LANGUAGE_BY_EXTENSION[extname(filePath).toLowerCase()] ?? null;
}

export function makeSourceFile(rootPath: string, relPath: string, absolutePath: string, content: string): SourceFile {
  return {
    path: relPath,
    absolutePath,
    language: languageOf(relPath) ?? 'javascript',
    size: Buffer.byteLength(content, 'utf8'),
    hash: sha256(content),
    content,
    lineCount: new LineIndex(content).lineCount,
  };
}

function parseEmbeddedJs(
  code: string,
  baseOffset: number,
  regions: DynamicRegion[],
  dynamic: boolean,
): JsParseResult {
  const first = parseJavaScriptFragment(code, baseOffset, 'script');
  if (first.ok || !dynamic) return first;

  const overlapping = regions.filter((region) => region.start < baseOffset + code.length && region.end > baseOffset);
  if (overlapping.length === 0) return first;

  let repaired = code;
  for (const region of overlapping) {
    const localStart = Math.max(0, region.start - baseOffset);
    const localEnd = Math.min(code.length, region.end - baseOffset);
    const length = localEnd - localStart;
    if (length <= 0) continue;
    repaired = repaired.slice(0, localStart) + '0' + ' '.repeat(length - 1) + repaired.slice(localEnd);
  }

  const second = parseJavaScriptFragment(repaired, baseOffset, 'script');
  return second.ok || second.errors.length < first.errors.length ? second : first;
}

function collectUnits(
  doc: HtmlDoc,
  text: string,
  regions: DynamicRegion[],
  problems: ParseProblem[],
  filePath: string,
): { jsUnits: JsUnit[]; cssUnits: CssUnit[] } {
  const jsUnits: JsUnit[] = [];
  const cssUnits: CssUnit[] = [];
  const index = new LineIndex(text);

  for (const element of doc.elements) {
    const tag = (element.tagName ?? '').toLowerCase();

    if (tag === 'script') {
      const typeAttr = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'type');
      const langAttr = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'language');
      const declared = (typeAttr?.value ?? langAttr?.value ?? '').toLowerCase().trim();
      const isVb = declared.includes('vbscript') || declared.includes('vbs');
      if (isVb || NON_JS_SCRIPT_TYPES.has(declared)) {
        // Non-JavaScript script blocks skip JS analysis; HTML rules report them instead
        continue;
      }
      if (declared && !JS_SCRIPT_TYPES.has(declared)) continue;

      const textChild = (element.childNodes ?? []).find((c) => c.nodeName === '#text');
      if (!textChild?.sourceCodeLocation) continue;
      const code = textChild.value ?? '';
      if (!code.trim()) continue;
      const baseOffset = textChild.sourceCodeLocation.startOffset;
      const endOffset = textChild.sourceCodeLocation.endOffset;
      const region = intersectsRegions(regions, baseOffset, endOffset);
      const result = parseEmbeddedJs(code, baseOffset, regions, Boolean(region));
      jsUnits.push({
        code,
        baseOffset,
        container: typeAttr?.value === 'module' ? '<script type="module">' : '<script>',
        result,
        dynamic: Boolean(region),
        dynamicRegion: region,
        startLine: index.positionAt(baseOffset).line,
      });
      for (const err of result.errors) {
        problems.push({
          filePath,
          phase: 'PARSE',
          message: `JavaScript 解析错误: ${err.message}`,
          line: index.positionAt(err.offset).line,
          column: index.positionAt(err.offset).column,
          recovered: err.recovered,
        });
      }
      continue;
    }

    if (tag === 'style') {
      const textChild = (element.childNodes ?? []).find((c) => c.nodeName === '#text');
      if (!textChild?.sourceCodeLocation) continue;
      const code = textChild.value ?? '';
      if (!code.trim()) continue;
      const baseOffset = textChild.sourceCodeLocation.startOffset;
      const endOffset = textChild.sourceCodeLocation.endOffset;
      const region = intersectsRegions(regions, baseOffset, endOffset);
      cssUnits.push({
        code,
        baseOffset,
        container: '<style>',
        result: parseCssFragment(code, baseOffset, filePath),
        dynamic: Boolean(region),
        dynamicRegion: region,
      });
      continue;
    }

    // Inline handlers are analyzed as JavaScript programs, located at the attribute value
    for (const attr of element.attrs ?? []) {
      if (!/^on[a-z]+$/i.test(attr.name)) continue;
      const raw = rawAttributeValue(element, attr.name, text);
      if (!raw || !raw.value.trim()) continue;
      const region = intersectsRegions(regions, raw.offset, raw.offset + raw.value.length);
      const result = parseEmbeddedJs(raw.value, raw.offset, regions, Boolean(region));
      jsUnits.push({
        code: raw.value,
        baseOffset: raw.offset,
        container: `${attr.name} attribute (<${tag}>)`,
        result,
        dynamic: Boolean(region),
        dynamicRegion: region,
        startLine: index.positionAt(raw.offset).line,
      });
    }
  }

  return { jsUnits, cssUnits };
}

export function parseSourceFile(file: SourceFile): ParsedFile {
  const index = new LineIndex(file.content);
  const problems: ParseProblem[] = [];
  const jsUnits: JsUnit[] = [];
  const cssUnits: CssUnit[] = [];
  let html: HtmlDoc | null = null;
  let jsp: JspAnalysis | null = null;
  let dynamicRegions: DynamicRegion[] = [];

  if (file.language === 'javascript') {
    const result = parseJavaScriptFragment(file.content, 0, 'script');
    jsUnits.push({
      code: file.content,
      baseOffset: 0,
      container: 'module top level',
      result,
      dynamic: false,
      dynamicRegion: null,
      startLine: 1,
    });
    for (const err of result.errors) {
      const pos = index.positionAt(err.offset);
      problems.push({
        filePath: file.path,
        phase: 'PARSE',
        message: `JavaScript 解析错误: ${err.message}`,
        line: pos.line,
        column: pos.column,
        recovered: err.recovered,
      });
    }
  } else if (file.language === 'css') {
    cssUnits.push({
      code: file.content,
      baseOffset: 0,
      container: 'stylesheet',
      result: parseCssFragment(file.content, 0, file.path),
      dynamic: false,
      dynamicRegion: null,
    });
  } else if (file.language === 'html' || file.language === 'jsp') {
    let htmlSource = file.content;
    if (file.language === 'jsp') {
      jsp = analyzeJsp(file.content);
      htmlSource = jsp.masked;
      dynamicRegions = jsp.regions;
    }
    html = parseHtml(htmlSource);
    const collected = collectUnits(html, htmlSource, dynamicRegions, problems, file.path);
    jsUnits.push(...collected.jsUnits);
    cssUnits.push(...collected.cssUnits);

    // parse5 emits a lot of noise; keep only diagnostics that affect structure or location
    for (const err of html.errors.slice(0, 5)) {
      if (!/missing-doctype|duplicate-attribute|non-void-html-element-start-tag/i.test(err.message)) continue;
      problems.push({
        filePath: file.path,
        phase: 'PARSE',
        message: `HTML 结构提示: ${err.message}`,
        line: err.line,
        column: err.column,
        recovered: true,
      });
    }
  }

  for (const unit of cssUnits) {
    for (const err of unit.result.errors) {
      const pos = index.positionAt(err.offset);
      problems.push({
        filePath: file.path,
        phase: 'PARSE',
        message: `CSS 解析错误: ${err.message}`,
        line: pos.line,
        column: pos.column,
        recovered: false,
      });
    }
  }

  const parsed =
    (file.language === 'javascript' && jsUnits.some((u) => u.result.ast !== null)) ||
    (file.language === 'css' && cssUnits.some((u) => u.result.root !== null)) ||
    ((file.language === 'html' || file.language === 'jsp') && html !== null && html.elements.length >= 0);

  return { file, index, language: file.language, jsUnits, cssUnits, html, jsp, dynamicRegions, problems, parsed };
}

export function readAndParse(absolutePath: string, relPath: string): ParsedFile {
  const content = readFileSync(absolutePath, 'utf8');
  const file = makeSourceFile('', relPath, absolutePath, content);
  return parseSourceFile(file);
}

export type { P5Node };

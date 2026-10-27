import type { AnalysisFinding, TextEdit } from '../model/types.js';
import type { ParsedFile } from '../parser/index.js';
import type { PreconditionResult, Recipe, RecipeContext } from './types.js';

interface AttributeHit {
  tagName: string;
  name: string;
  value: string;
  start: number;
  end: number;
}

interface ElementHit {
  tagName: string;
  start: number;
  end: number;
  attrs: Record<string, string>;
}

function findAttributeByRange(parsed: ParsedFile, start: number, end: number): AttributeHit | null {
  const html = parsed.html;
  if (!html) return null;
  for (const element of html.elements) {
    const loc = element.sourceCodeLocation;
    if (!loc?.attrs) continue;
    for (const [name, attrLoc] of Object.entries(loc.attrs)) {
      if (!attrLoc || attrLoc.startOffset !== start || attrLoc.endOffset !== end) continue;
      const attr = (element.attrs ?? []).find((item) => item.name === name);
      return {
        tagName: (element.tagName ?? '').toLowerCase(),
        name,
        value: attr?.value ?? '',
        start,
        end,
      };
    }
  }
  return null;
}

function findElementByRange(parsed: ParsedFile, start: number, end: number): ElementHit | null {
  const html = parsed.html;
  if (!html) return null;
  for (const element of html.elements) {
    const loc = element.sourceCodeLocation;
    if (!loc || loc.startOffset !== start || loc.endOffset !== end) continue;
    const attrs: Record<string, string> = {};
    for (const attr of element.attrs ?? []) attrs[attr.name.toLowerCase()] = attr.value;
    return { tagName: (element.tagName ?? '').toLowerCase(), start, end, attrs };
  }
  return null;
}

/** Deletes a whole element and its own line, so no blank line is left behind. */
function deleteElementEdit(text: string, start: number, end: number): TextEdit {
  let from = start;
  let to = end;
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, start))) from = lineStart;
  while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to += 1;
  if (text[to] === '\r') to += 1;
  if (text[to] === '\n') to += 1;
  return { start: from, end: to, newText: '', ruleId: '', reason: '' };
}

const removeScriptLanguage: Recipe = {
  id: 'RCP-SCRIPT-LANGUAGE',
  name: 'Remove obsolete script language attribute',
  version: '1.0.0',
  ruleIds: ['WL-HTML-003'],
  level: 'SAFE',
  summary: 'Deletes language="JavaScript" from the <script> tag; Chrome infers the type anyway.',
  caveats: ['Only the attribute is removed — the script body is not touched.'],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findAttributeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return { ok: false, reasons: ['The attribute is no longer at this position; re-scan the file.'] };
    if (hit.tagName !== 'script') return { ok: false, reasons: ['The attribute is not on a <script> element.'] };
    if (hit.name.toLowerCase() !== 'language') return { ok: false, reasons: ['The attribute is no longer "language".'] };
    if (/vbscript|vbs/i.test(hit.value)) {
      return { ok: false, reasons: ['VBScript blocks need a manual rewrite; removing the attribute would change nothing.'] };
    }
    return { ok: true, reasons: [] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findAttributeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    // Swallow one preceding space so the tag does not end up with a double space.
    const start = hit.start > 0 && /\s/.test(ctx.text[hit.start - 1]) ? hit.start - 1 : hit.start;
    return [
      {
        start,
        end: hit.end,
        newText: '',
        ruleId: 'WL-HTML-003',
        reason: 'The language attribute is obsolete in HTML5; Chrome derives the script type from type/absence.',
      },
    ];
  },
};

const removeIeDocumentMode: Recipe = {
  id: 'RCP-DROP-UA-COMPATIBLE',
  name: 'Remove X-UA-Compatible document mode',
  version: '1.0.0',
  ruleIds: ['WL-HTML-008'],
  level: 'SAFE',
  summary: 'Deletes the IE document-mode <meta> tag, which Chrome ignores.',
  caveats: [
    'Only remove it once the page is no longer served to IE; the tag is still meaningful for IE clients.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findElementByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return { ok: false, reasons: ['The <meta> element is no longer at this position; re-scan the file.'] };
    if (hit.tagName !== 'meta') return { ok: false, reasons: ['The element is no longer a <meta> tag.'] };
    const httpEquiv = (hit.attrs['http-equiv'] ?? '').toLowerCase();
    if (!httpEquiv.includes('x-ua-compatible')) {
      return { ok: false, reasons: ['This <meta> is no longer an X-UA-Compatible declaration.'] };
    }
    return { ok: true, reasons: [] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findElementByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    return [
      {
        ...deleteElementEdit(ctx.text, hit.start, hit.end),
        ruleId: 'WL-HTML-008',
        reason: 'Chrome ignores X-UA-Compatible; the declaration only existed to pin IE rendering mode.',
      },
    ];
  },
};

export const htmlRecipes: Recipe[] = [removeScriptLanguage, removeIeDocumentMode];

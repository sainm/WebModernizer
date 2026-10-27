import type { AnalysisFinding, TextEdit } from '../model/types.js';
import type { ParsedFile } from '../parser/index.js';
import type { CssDeclaration } from '../parser/cssParser.js';
import { standardForMs } from '../analysis/cssStandards.js';
import type { PreconditionResult, Recipe, RecipeContext } from './types.js';

interface DeclarationHit {
  decl: CssDeclaration;
  code: string;
}

/**
 * Finds the real stylesheet declaration that produced this finding.
 *
 * Inline `style=""` attributes are analyzed too, but they are synthesized as a single
 * pseudo-declaration covering the whole attribute value. Returning null for them keeps
 * the CSS recipes away from a range that would delete the entire attribute.
 */
function findDeclaration(parsed: ParsedFile, start: number, end: number): DeclarationHit | null {
  for (const unit of parsed.cssUnits) {
    for (const decl of unit.result.declarations) {
      if (decl.startOffset === start && decl.endOffset === end) return { decl, code: unit.code };
    }
  }
  return null;
}

function eol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Deletes one declaration. When it occupies its own line the whole line goes, so the
 * stylesheet does not accumulate blank lines; when several declarations share a line
 * only the target is cut out.
 */
function deleteDeclaration(text: string, start: number, end: number): { start: number; end: number } {
  let to = end;
  while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to += 1;

  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEndRaw = text.indexOf('\n', to);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const before = text.slice(lineStart, start);
  const after = text.slice(to, lineEnd).replace(/\r$/, '');

  if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) {
    return { start: lineStart, end: lineEndRaw === -1 ? text.length : lineEndRaw + 1 };
  }

  // Shared line: delete the declaration and the spaces that follow it, but keep the
  // space before it so the neighbouring declarations stay separated.
  return { start, end: to };
}

const dropIeHack: Recipe = {
  id: 'RCP-DROP-CSS-HACK',
  name: 'Drop IE CSS hack declaration',
  version: '1.0.0',
  ruleIds: ['WL-CSS-005'],
  level: 'SAFE',
  summary: 'Deletes the star/underscore declaration or the \\9 value hack.',
  caveats: [
    'Chrome already discards these declarations, so removing them cannot change how the page renders today.',
    'If the property was only declared through the hack, the computed value still does not change in Chrome — it was never applied.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findDeclaration(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) {
      return { ok: false, reasons: ['The declaration is no longer at this position, or it comes from an inline style attribute.'] };
    }
    const raw = hit.decl.raw;
    const hasHack = /(?:^|;)\s*[*_][a-z-]+\s*:/i.test(raw) || /\\9\b/.test(raw);
    if (!hasHack) return { ok: false, reasons: ['The declaration no longer contains a hack.'] };
    return { ok: true, reasons: [] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findDeclaration(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const range = deleteDeclaration(ctx.text, hit.decl.startOffset, hit.decl.endOffset);
    return [
      {
        start: range.start,
        end: range.end,
        newText: '',
        ruleId: 'WL-CSS-005',
        reason: 'Chrome parses these declarations as invalid and drops them; the hack only existed for IE.',
      },
    ];
  },
};

const renameToStandard: Recipe = {
  id: 'RCP-RENAME-MS-PROP',
  name: 'Rename -ms- property to the standard one',
  version: '1.0.0',
  ruleIds: ['WL-CSS-004'],
  level: 'CONDITIONAL',
  summary: 'Renames the prefixed property in place; the value and formatting stay untouched.',
  caveats: [
    'Rendering changes: the declaration was ignored by Chrome before and now applies.',
    'IE support for this declaration is dropped — that is the intent of the migration, but confirm no IE client remains.',
    'Only properties with identical value syntax are handled; -ms-flex and -ms-writing-mode are refused.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findDeclaration(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return { ok: false, reasons: ['The declaration is no longer at this position.'] };
    const prop = hit.decl.prop.toLowerCase();
    const standard = standardForMs(prop);
    if (!standard) {
      return {
        ok: false,
        reasons: [`${prop} has no standard equivalent with the same value syntax; copying the value would change behaviour.`],
      };
    }
    if (!hit.decl.raw.toLowerCase().startsWith(prop)) {
      return { ok: false, reasons: ['The declaration text does not start with the property name; refusing to guess an edit range.'] };
    }
    const duplicate = ctx.parsed.cssUnits
      .flatMap((unit) => unit.result.declarations)
      .some((decl) => decl.prop.toLowerCase() === standard && decl.selector === hit.decl.selector);
    if (duplicate) {
      return { ok: false, reasons: [`${standard} is already declared in the same rule; renaming would create a duplicate.`] };
    }
    return { ok: true, reasons: [`Confirm ${standard} is acceptable for every browser this stylesheet still serves.`] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findDeclaration(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const standard = standardForMs(hit.decl.prop.toLowerCase());
    if (!standard) return null;
    if (!hit.decl.raw.toLowerCase().startsWith(hit.decl.prop.toLowerCase())) return null;

    // Renaming only the property token keeps the value, whitespace and trailing
    // semicolon exactly as they were, and makes the finding disappear.
    return [
      {
        start: hit.decl.startOffset,
        end: hit.decl.startOffset + hit.decl.prop.length,
        newText: standard,
        ruleId: 'WL-CSS-004',
        reason: `${hit.decl.prop} is ignored by Chrome; ${standard} accepts the same value syntax.`,
      },
    ];
  },
};

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

export const cssRecipes: Recipe[] = [dropIeHack, renameToStandard];

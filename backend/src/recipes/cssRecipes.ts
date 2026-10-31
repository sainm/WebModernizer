import type { AnalysisFinding, TextEdit } from '../model/types.js';
import type { ParsedFile } from '../parser/index.js';
import type { CssDeclaration } from '../parser/cssParser.js';
import { alphaOpacityValue, ieGradientValue, standardForMs } from '../analysis/cssStandards.js';
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

function opacityText(value: number): string {
  const fixed = (value / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '' ? '0' : fixed;
}

const ieFilter: Recipe = {
  id: 'RCP-IE-FILTER',
  name: 'IE filter -> opacity or linear-gradient',
  version: '1.0.0',
  ruleIds: ['WL-CSS-003'],
  level: 'CONDITIONAL',
  summary:
    'Replaces an alpha-only filter with opacity, or a simple two-color gradient filter with background-image: linear-gradient(...).',
  caveats: [
    'Only alpha(opacity=N), the MS Alpha progid, or a single gradient with two 3/6-digit hex colors and gradientType 0 or 1 is converted; shadows, combined filters, 8-digit ARGB colors and extra stops stay manual.',
    'opacity creates a stacking context and fades descendants; verify layered and nested content after the change.',
    'The recipe refuses when the same rule already declares opacity, background-image, or a background shorthand after the filter.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findDeclaration(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) {
      return { ok: false, reasons: ['The declaration is no longer at this position, or it comes from an inline style attribute.'] };
    }
    const prop = hit.decl.prop.toLowerCase();
    if (prop !== 'filter' && prop !== '-ms-filter') {
      return { ok: false, reasons: ['The declaration is no longer an IE filter property.'] };
    }
    if (!hit.decl.raw.toLowerCase().startsWith(prop)) {
      return { ok: false, reasons: ['The declaration text does not start with the property name; refusing to guess an edit range.'] };
    }
    const opacity = alphaOpacityValue(hit.decl.value);
    const gradient = opacity === null ? ieGradientValue(hit.decl.value) : null;
    if (opacity === null && gradient === null) {
      return { ok: false, reasons: ['The filter value is not a simple alpha-only or two-color gradient form that can be mapped mechanically.'] };
    }
    const declarations = ctx.parsed.cssUnits.flatMap((unit) => unit.result.declarations);
    if (opacity !== null) {
      const duplicate = declarations.some(
        (decl) => decl.prop.toLowerCase() === 'opacity' && decl.selector === hit.decl.selector,
      );
      if (duplicate) {
        return { ok: false, reasons: ['The same rule already declares opacity; adding another would make the result order-dependent.'] };
      }
      return { ok: true, reasons: ['Verify stacking context and nested content after removing the filter.'] };
    }
    const siblings = declarations.filter(
      (decl) =>
        decl.selector === hit.decl.selector &&
        JSON.stringify(decl.atRuleChain) === JSON.stringify(hit.decl.atRuleChain),
    );
    if (siblings.some((decl) => decl.prop.toLowerCase() === 'background-image')) {
      return { ok: false, reasons: ['The same rule already declares background-image; adding a gradient would duplicate or override it.'] };
    }
    if (
      siblings.some(
        (decl) => decl.prop.toLowerCase() === 'background' && decl.startOffset > hit.decl.startOffset,
      )
    ) {
      return { ok: false, reasons: ['A background shorthand is declared after the filter and would override the new gradient.'] };
    }
    return { ok: true, reasons: ['Verify the existing background fallback and layered content.'] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findDeclaration(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const opacity = alphaOpacityValue(hit.decl.value);
    const gradient = opacity === null ? ieGradientValue(hit.decl.value) : null;
    if (opacity === null && gradient === null) return null;
    const important = hit.decl.important ? ' !important' : '';
    const semicolon = /;\s*$/.test(hit.decl.raw) ? ';' : '';
    if (opacity !== null) {
      return [
        {
          start: hit.decl.startOffset,
          end: hit.decl.endOffset,
          newText: `opacity: ${opacityText(opacity)}${important}${semicolon}`,
          ruleId: 'WL-CSS-003',
          reason: 'Chrome ignores the IE alpha filter; opacity is the standard equivalent for a single opacity value.',
        },
      ];
    }
    if (gradient === null) return null;
    return [
      {
        start: hit.decl.startOffset,
        end: hit.decl.endOffset,
        newText: `background-image: linear-gradient(${gradient.direction}, ${gradient.startColor}, ${gradient.endColor})${important}${semicolon}`,
        ruleId: 'WL-CSS-003',
        reason: 'The IE gradient filter is ignored by Chrome; linear-gradient() is the standard equivalent for two colors.',
      },
    ];
  },
};

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

export const cssRecipes: Recipe[] = [dropIeHack, renameToStandard, ieFilter];

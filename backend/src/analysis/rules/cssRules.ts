import { rawAttributeValue } from '../../parser/htmlParser.js';
import { standardForMs } from '../cssStandards.js';
import type { CssDeclaration } from '../../parser/cssParser.js';
import type { FileContext, RawFinding, Rule, RuleDraft } from '../types.js';
import { makeFinding } from '../finding.js';

const ruleList: RuleDraft[] = [];

function define(draft: RuleDraft): void {
  ruleList.push(draft);
}

function asRule(draft: RuleDraft): Rule {
  return draft as unknown as Rule;
}

interface CssHit {
  declaration: CssDeclaration;
  /** Absolute offset of the interesting substring inside the declaration */
  offset: number;
  length: number;
  container: string;
}

/**
 * Visits every declaration once, including declarations that live in inline
 * style="" attributes. Inline styles matter: IE-era pages put expression() and
 * filter:progid there as often as in <style> blocks.
 */
function eachDeclaration(ctx: FileContext, visit: (hit: CssHit) => void): void {
  for (const unit of ctx.parsed.cssUnits) {
    for (const decl of unit.result.declarations) {
      const container = unit.container;
      visit({ declaration: decl, offset: decl.startOffset, length: decl.endOffset - decl.startOffset, container });
    }
  }

  const html = ctx.parsed.html;
  if (!html) return;
  for (const element of html.elements) {
    const styleAttr = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'style');
    if (!styleAttr) continue;
    const raw = rawAttributeValue(element, 'style', ctx.text);
    if (!raw || !raw.value.trim()) continue;
    const tag = (element.tagName ?? '').toLowerCase();
    const pseudo: CssDeclaration = {
      prop: '',
      value: raw.value,
      important: false,
      startOffset: raw.offset,
      endOffset: raw.offset + raw.value.length,
      startLine: 0,
      startColumn: 0,
      raw: raw.value,
      selector: `<${tag} style>`,
      atRuleChain: [],
    };
    visit({
      declaration: pseudo,
      offset: raw.offset,
      length: raw.value.length,
      container: `style attribute on <${tag}>`,
    });
  }
}

function matchInDeclaration(hit: CssHit, pattern: RegExp): { offset: number; matched: string } | null {
  const raw = hit.declaration.raw;
  pattern.lastIndex = 0;
  const match = pattern.exec(raw);
  if (!match) return null;
  return { offset: hit.offset + match.index, matched: match[0] };
}

define({
  meta: {
    id: 'WL-CSS-001',
    name: 'CSS expression()',
    version: '1.0.0',
    description: 'IE dynamic CSS expressions. Chrome dropped support: the declaration is discarded, not executed.',
    language: 'css',
    category: 'CSS_COMPAT',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'MANUAL',
    basis: 'A CSS declaration whose raw text contains expression( (case-insensitive), including inline style attributes.',
    tags: ['ie-only', 'dynamic-css'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachDeclaration(ctx, (hit) => {
      const found = matchInDeclaration(hit, /expression\s*\(/i);
      if (!found) return;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: found.offset,
          endOffset: found.offset + found.matched.length,
          message: `Uses CSS expression() in ${hit.declaration.prop || 'inline style'}`,
          risk:
            'Chrome removed CSS expressions entirely. The whole declaration is dropped at parse time, so the element loses that dimension: width becomes auto, top becomes 0, and the layout collapses. No error is logged, so this only shows up visually.',
          recommendation:
            'Replace the expression with a static value computed at build time, or move the dynamic calculation into JavaScript (element.style.width = ...). Any expression that depended on scroll position or window size needs a resize handler, so the replacement is logic, not styling.',
          evidence: {
            kind: 'CssDeclaration',
            matched: found.matched,
            container: hit.container,
            detail: {
              property: hit.declaration.prop || 'inline style',
              selector: hit.declaration.selector ?? '(none)',
              declaration: hit.declaration.raw.slice(0, 200),
            },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-CSS-002',
    name: 'CSS behavior property',
    version: '1.0.0',
    description: 'IE CSS behaviors (.htc components) attach script to elements through the behavior property.',
    language: 'css',
    category: 'CSS_COMPAT',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'A declaration whose property is behavior or -ms-behavior.',
    tags: ['htc', 'blocker'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachDeclaration(ctx, (hit) => {
      const prop = hit.declaration.prop.toLowerCase();
      if (prop !== 'behavior' && prop !== '-ms-behavior') return;
      const value = hit.declaration.raw;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: hit.offset,
          endOffset: hit.offset + value.length,
          message: 'Attaches an IE CSS behavior (.htc)',
          risk:
            'Chrome does not implement behaviors. The .htc file is never loaded, so every behavior it injected (hover fixes, rounded corners, custom scrollbars, validation) is missing. Because the .htc is not requested, no network error appears either.',
          recommendation:
            'Open the referenced .htc and port its logic: visual fixes usually map to CSS pseudo-classes or transitions, interactive behavior maps to event listeners. Treat as unsupported for automation since the .htc is a separate codebase.',
          evidence: {
            kind: 'CssDeclaration',
            matched: value.slice(0, 160),
            container: hit.container,
            detail: {
              value: hit.declaration.value.slice(0, 200),
              selector: hit.declaration.selector ?? '(none)',
            },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-CSS-003',
    name: 'IE filter (progid / alpha)',
    version: '1.0.0',
    description: 'IE proprietary filter values: progid:DXImageTransform gradients and alpha(opacity) transparency.',
    language: 'css',
    category: 'CSS_COMPAT',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'Property -ms-filter, or property filter whose value contains progid: or alpha(opacity.',
    tags: ['ie-only', 'filter'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachDeclaration(ctx, (hit) => {
      const prop = hit.declaration.prop.toLowerCase();
      const value = hit.declaration.value;
      const isIeFilter =
        prop === '-ms-filter' || (prop === 'filter' && /progid\s*:|alpha\s*\(\s*opacity/i.test(value));
      if (!isIeFilter) return;
      const isOpacity = /alpha\s*\(\s*opacity/i.test(value);
      const isGradient = /gradient/i.test(value);
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: hit.offset,
          endOffset: hit.offset + hit.declaration.raw.length,
          severity: isOpacity ? 'MEDIUM' : 'MEDIUM',
          message: isOpacity ? 'Uses IE alpha(opacity) for transparency' : 'Uses IE filter progid:DXImageTransform',
          variant: isOpacity ? 'opacity' : 'gradient',
          risk: isGradient
            ? 'Chrome ignores the IE gradient filter, so the element renders without any background gradient. Fallback colors may still apply, which hides the problem on some pages and exposes it on others.'
            : 'Chrome ignores alpha(opacity), so the element stays fully opaque. Because the value is syntactically valid CSS, nothing warns about it.',
          recommendation: isGradient
            ? 'Replace with a standard linear-gradient()/radial-gradient() background, then verify the fallback for older Chrome versions is acceptable.'
            : 'Replace with opacity or rgba() on the same rule. Note the semantic difference: IE alpha applied per element without affecting children the same way, so check nested content after the change.',
          evidence: {
            kind: 'CssDeclaration',
            matched: hit.declaration.raw.slice(0, 160),
            container: hit.container,
            detail: {
              property: hit.declaration.prop,
              value: value.slice(0, 200),
              selector: hit.declaration.selector ?? '(none)',
            },
          },
        }),
      );
    });
    return out;
  },
});

/**
 * Not every -ms- prefix is dead. Some properties are still honored by Chromium
 * (overflow-style, high-contrast) while others were dropped with the old engine.
 * Reporting them all as "invalid" would create noise and erode trust in the scan.
 */
const MS_OBSOLETE = new Set([
  '-ms-flex',
  '-ms-flex-align',
  '-ms-flex-pack',
  '-ms-flex-order',
  '-ms-flex-positive',
  '-ms-flex-negative',
  '-ms-flex-preferred-size',
  '-ms-flex-flow',
  '-ms-flex-direction',
  '-ms-flex-wrap',
  '-ms-flex-item-align',
  '-ms-flex-line-pack',
  '-ms-transform',
  '-ms-transform-origin',
  '-ms-transition',
  '-ms-transition-property',
  '-ms-transition-duration',
  '-ms-animation',
  '-ms-animation-name',
  '-ms-user-select',
  '-ms-touch-action',
  '-ms-writing-mode',
  '-ms-zoom',
  '-ms-box-sizing',
  '-ms-box-shadow',
  '-ms-border-radius',
  '-ms-opacity',
  '-ms-ime-mode',
  '-ms-interpolation-mode',
  '-ms-filter',
]);

const MS_STILL_FUNCTIONAL = new Set([
  '-ms-overflow-style',
  '-ms-high-contrast',
  '-ms-high-contrast-adjust',
  '-ms-ime-align',
  '-ms-scroll-chaining',
  '-ms-scroll-snap-type',
  '-ms-scroll-snap-points-x',
  '-ms-scroll-snap-points-y',
  '-ms-hyphens',
  '-ms-text-size-adjust',
  '-ms-content-zooming',
  '-ms-accelerator',
]);

define({
  meta: {
    id: 'WL-CSS-004',
    name: 'Vendor -ms- prefixed property',
    version: '1.0.0',
    description:
      'Microsoft vendor prefixes. Obsolete ones are ignored by Chrome; a few are still implemented and must not be reported as invalid.',
    language: 'css',
    category: 'CSS_COMPAT',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'CONDITIONAL',
    basis:
      'Declaration property starting with -ms-, split into an obsolete list, a still-functional list, and a value-syntax check for the standard equivalent.',
    recipeId: 'RCP-RENAME-MS-PROP',
    tags: ['vendor-prefix'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachDeclaration(ctx, (hit) => {
      const prop = hit.declaration.prop.toLowerCase();
      if (!prop.startsWith('-ms-')) return;
      if (prop === '-ms-filter') return; // covered by WL-CSS-003
      if (prop === '-ms-behavior') return; // covered by WL-CSS-002
      const obsolete = MS_OBSOLETE.has(prop) || !MS_STILL_FUNCTIONAL.has(prop);
      // A recipe exists only when the standard property accepts the same value syntax.
      const standard = obsolete ? standardForMs(prop) : null;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: hit.offset,
          endOffset: hit.offset + hit.declaration.raw.length,
          severity: obsolete ? 'MEDIUM' : 'LOW',
          confidence: obsolete ? 'CONFIRMED' : 'POSSIBLE',
          message: obsolete
            ? `Uses obsolete vendor property ${prop}`
            : `Uses ${prop}, which Chromium still honors`,
          variant: obsolete ? 'obsolete' : 'functional',
          migrationLevel: standard ? 'CONDITIONAL' : 'MANUAL',
          risk: obsolete
            ? `Chrome ignores ${prop}. If the standard equivalent is not also declared, the element silently loses that style, which usually shows up as a layout or alignment regression rather than an error.`
            : `${prop} is a Microsoft-specific property that Chromium still implements (mainly for forced-colors and scrollbar behavior). It is not dead code: removing it can change the rendering, so it must be checked rather than bulk-deleted.`,
          recommendation: obsolete
            ? standard
              ? `Add \`${standard}\` with the same value above this line; both properties then apply, so the page renders correctly in Chrome and still works in IE.`
              : `Add the standard property next to it.${standardFor(prop)} Then remove the -ms- line once visual comparison passes.`
            : 'Keep it for now. Verify with the browser validation step whether it still affects rendering, and only remove it if the visual diff is clean.',
          evidence: {
            kind: 'CssDeclaration',
            matched: hit.declaration.raw.slice(0, 160),
            container: hit.container,
            detail: {
              property: prop,
              classification: obsolete ? 'obsolete' : 'still-functional',
              selector: hit.declaration.selector ?? '(none)',
            },
          },
        }),
      );
    });
    return out;
  },
});

function standardFor(prop: string): string {
  const map: Record<string, string> = {
    '-ms-flex': 'flex',
    '-ms-flex-align': 'align-items',
    '-ms-flex-pack': 'justify-content',
    '-ms-transform': 'transform',
    '-ms-transform-origin': 'transform-origin',
    '-ms-transition': 'transition',
    '-ms-animation': 'animation',
    '-ms-user-select': 'user-select',
    '-ms-touch-action': 'touch-action',
    '-ms-writing-mode': 'writing-mode',
    '-ms-box-sizing': 'box-sizing',
    '-ms-box-shadow': 'box-shadow',
    '-ms-border-radius': 'border-radius',
    '-ms-ime-mode': '(no equivalent; handles IME composition, remove)',
  };
  const standard = map[prop];
  return standard ? ` Standard equivalent: ${standard}.` : '';
}

define({
  meta: {
    id: 'WL-CSS-005',
    name: 'IE CSS hack syntax',
    version: '1.0.0',
    description: 'Star property hacks (*zoom), underscore hacks (_height), and the \\9 value hack.',
    language: 'css',
    category: 'CSS_COMPAT',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'SAFE',
    basis: 'Raw declaration prefix * or _, or a value/selector containing \\9; PostCSS normalizes the star away, so the raw text is inspected.',
    recipeId: 'RCP-DROP-CSS-HACK',
    tags: ['css-hack'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachDeclaration(ctx, (hit) => {
      const raw = hit.declaration.raw;
      // A style="" attribute holds several declarations, so the hack can start after
      // any ';' boundary rather than at the start of the raw text.
      const hackMatch = /(?:^|;)\s*([*_])[a-z-]+\s*:/i.exec(raw);
      const valueHack = /\\9\b/.test(raw) || /\\0\b/.test(raw);
      if (!hackMatch && !valueHack) return;
      const kind = hackMatch ? (hackMatch[1] === '*' ? 'star hack' : 'underscore hack') : '\\9 value hack';
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: hit.offset,
          endOffset: hit.offset + raw.length,
          message: `Uses IE CSS hack (${kind})`,
          risk:
            'These hacks exist only to feed different values to different IE versions. Chrome parses the star/underscore prefixed declaration as invalid and drops it, so the value meant for IE is inactive and the value meant for other browsers applies. The result is usually correct, but the rule now contains dead declarations that mask the real intended value.',
          recommendation:
            'Remove the hack declaration and keep the value intended for modern browsers. Verify the element afterwards: some teams relied on the hack value being ignored to keep a fallback, so compare before/after.',
          evidence: {
            kind: 'CssDeclaration',
            matched: raw.slice(0, 120),
            container: hit.container,
            detail: {
              hack: kind,
              selector: hit.declaration.selector ?? '(none)',
              property: hit.declaration.prop,
            },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-CSS-006',
    name: 'zoom property',
    version: '1.0.0',
    description: 'The non-standard zoom property is widely used in IE-era layouts for hasLayout fixes.',
    language: 'css',
    category: 'CSS_COMPAT',
    defaultSeverity: 'LOW',
    defaultMigrationLevel: 'MANUAL',
    basis: 'A declaration whose property is zoom.',
    tags: ['layout'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachDeclaration(ctx, (hit) => {
      const prop = hit.declaration.prop.toLowerCase();
      if (prop !== 'zoom') return;
      // A star-prefixed zoom is already reported as a hack; avoid double reporting.
      if (/(?:^|;)\s*[*_][a-z-]+\s*:/i.test(hit.declaration.raw)) return;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: hit.offset,
          endOffset: hit.offset + hit.declaration.raw.length,
          message: 'Uses non-standard zoom property',
          risk:
            'Chrome implements zoom, so this usually still works — but it is non-standard, scales layout in ways that interact badly with transforms, and in IE-era code it was often a hasLayout trigger rather than an actual zoom.',
          recommendation:
            'Check whether the value is 1: if so, the declaration exists only for hasLayout and can be deleted. If it really scales, keep it or switch to transform: scale() with an explicit transform-origin.',
          confidence: 'POSSIBLE',
          evidence: {
            kind: 'CssDeclaration',
            matched: hit.declaration.raw.slice(0, 120),
            container: hit.container,
            detail: {
              value: hit.declaration.value,
              selector: hit.declaration.selector ?? '(none)',
            },
          },
        }),
      );
    });
    return out;
  },
});

export const cssRules: RuleDraft[] = ruleList;
export { asRule, eachDeclaration };

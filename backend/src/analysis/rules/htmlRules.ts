import type { P5Node } from '../../parser/htmlParser.js';
import { attributeLocation, isConditionalComment, rawAttributeValue } from '../../parser/htmlParser.js';
import type { FileContext, RawFinding, Rule, RuleDraft } from '../types.js';
import { makeFinding } from '../finding.js';

const ruleList: RuleDraft[] = [];

function define(draft: RuleDraft): void {
  ruleList.push(draft);
}

function asRule(draft: RuleDraft): Rule {
  return draft as unknown as Rule;
}

interface LegacyElementSpec {
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  risk: string;
  recommendation: string;
}

const LEGACY_ELEMENTS: Record<string, LegacyElementSpec> = {
  marquee: {
    severity: 'MEDIUM',
    risk:
      'Chrome does not implement <marquee>. The tag survives as an unknown inline element, so the text still appears but no longer scrolls, and any layout that relied on the scrolling box changes.',
    recommendation: 'Replace with a CSS animation or a carousel component. If the scrolling is decorative only, simply drop the element.',
  },
  blink: {
    severity: 'LOW',
    risk: 'Chrome treats <blink> as an unknown element; text renders statically. No script error occurs, so the change is purely visual.',
    recommendation: 'Remove the tag. Blinking text is also an accessibility problem; do not reimplement it with CSS.',
  },
  bgsound: {
    severity: 'MEDIUM',
    risk: '<bgsound> is an IE-only element. Chrome never plays the referenced audio, and no error is raised, so the loss is silent.',
    recommendation: 'Remove it, or move to <audio autoplay muted> plus an explicit user-triggered play() call, since modern autoplay policies block unrequested audio.',
  },
  layer: {
    severity: 'HIGH',
    risk:
      'Netscape/IE <layer> elements are not rendered by Chrome at all. Content inside a layer disappears entirely, and absolute positioning that referenced the layer collapses.',
    recommendation: 'Convert to a positioned <div> with explicit top/left/z-index, then visually compare the page before and after.',
  },
  ilayer: {
    severity: 'HIGH',
    risk: 'Inline layers are dropped by Chrome, so the inline content vanishes from the document flow.',
    recommendation: 'Convert to an inline-block <span>/<div> and re-check the surrounding text flow.',
  },
  font: {
    severity: 'LOW',
    risk: '<font> is obsolete but Chrome still honors it, so replacing it is not required for correctness. The risk is that color/size attributes do not participate in CSS cascade and override nothing, which makes later styling harder.',
    recommendation: 'Move the presentation to CSS classes when the page is touched anyway. Safe to leave in place for the first migration pass.',
  },
  center: {
    severity: 'LOW',
    risk: '<center> still works in Chrome (it is mapped to text-align: center). No behavior break; only obsolete markup.',
    recommendation: 'Replace with a CSS class using margin-inline: auto or text-align: center when convenient.',
  },
  spacer: {
    severity: 'LOW',
    risk: '<spacer> is not rendered by Chrome; spacing collapses and layout shifts.',
    recommendation: 'Replace with margin or a sized empty element.',
  },
  nobr: {
    severity: 'LOW',
    risk: '<nobr> is not supported by Chrome; text that should stay on one line now wraps, which can break table layouts.',
    recommendation: 'Replace with white-space: nowrap.',
  },
  plaintext: {
    severity: 'MEDIUM',
    risk: '<plaintext> makes the HTML parser treat the rest of the document as raw text. Chrome keeps this behavior, but it also means no markup after this point is parsed, which usually hides other compatibility problems.',
    recommendation: 'Remove <plaintext> and escape the literal text instead, then re-scan the file.',
  },
  xmp: {
    severity: 'LOW',
    risk: '<xmp> still renders as preformatted text in Chrome but is obsolete and disables markup parsing inside it.',
    recommendation: 'Replace with <pre><code> and HTML-escape the content.',
  },
  isindex: {
    severity: 'LOW',
    risk: '<isindex> is not implemented in Chrome; the implicit search form never renders.',
    recommendation: 'Replace with an explicit <form><input type="search"></form>.',
  },
};

const IE_ONLY_ATTRIBUTES: Record<string, string> = {
  dynsrc: 'dynsrc lets IE play a video inside <img>. Chrome ignores the attribute, so only the static src image is shown.',
  lowsrc: 'lowsrc is an IE placeholder-image attribute; Chrome ignores it.',
  datasrc: 'datasrc is IE data binding; Chrome has no equivalent.',
  datafld: 'datafld is IE data binding; Chrome has no equivalent.',
  dataformatas: 'dataformatas is IE data binding; Chrome has no equivalent.',
  language: 'The language attribute on <script> is obsolete. Chrome infers the type, but the declaration signals IE-era code worth reviewing.',
  for: 'The for/event attribute pair on <script> is IE-only event binding, not standard DOM event registration.',
};

define({
  meta: {
    id: 'WL-HTML-001',
    name: 'IE conditional comment',
    version: '1.0.0',
    description: 'Downlevel-hidden/ revealed conditional comments such as <!--[if IE]> ... <![endif]--> are evaluated only by IE.',
    language: 'html',
    category: 'HTML_COMPAT',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'HTML comment nodes whose data matches the [if ... IE] / [endif] pattern.',
    tags: ['conditional-comment', 'ie-only'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const comment of html.comments) {
      const data = comment.data ?? '';
      if (!isConditionalComment(data)) continue;
      const loc = comment.sourceCodeLocation;
      if (!loc) continue;
      const carriesAssets = /<script|<link|<style/i.test(data);
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          severity: carriesAssets ? 'HIGH' : 'MEDIUM',
          message: 'Contains an IE conditional comment block',
          variant: carriesAssets ? 'assets' : 'plain',
          risk: carriesAssets
            ? 'Chrome treats the whole block as a comment. Because this block loads scripts or stylesheets, those assets are never fetched on Chrome, so the page silently loses functionality that only existed inside the conditional branch.'
            : 'Chrome ignores conditional comments entirely, so any markup or script inside the block does not exist for Chrome. Functionality implemented only there is silently missing.',
          recommendation:
            'Decide per block: if it is an IE-only polyfill or fix, delete it; if it contains real business markup, move it out of the comment and guard it with feature detection instead of browser sniffing. The block cannot be converted mechanically because the intent is business-specific.',
          confidence: 'CONFIRMED',
          evidence: {
            kind: 'ConditionalComment',
            matched: data.replace(/\s+/g, ' ').slice(0, 160),
            detail: {
              carriesAssets,
              length: data.length,
            },
          },
        }),
      );
    }
    return out;
  },
});

define({
  meta: {
    id: 'WL-HTML-002',
    name: 'Legacy or IE-only element',
    version: '1.0.0',
    description: 'Elements that are obsolete, IE-only, or not implemented by Chrome.',
    language: 'html',
    category: 'HTML_COMPAT',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'Element tag names matched against a curated list (marquee, blink, bgsound, layer, font, center, ...).',
    tags: ['obsolete-element'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const element of html.elements) {
      const tag = (element.tagName ?? '').toLowerCase();
      const spec = LEGACY_ELEMENTS[tag];
      if (!spec) continue;
      const loc = element.sourceCodeLocation;
      if (!loc) continue;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          severity: spec.severity,
          message: `Uses legacy element <${tag}>`,
          risk: spec.risk,
          recommendation: spec.recommendation,
          confidence: 'CONFIRMED',
          evidence: {
            kind: 'Element',
            matched: ctx.text.slice(loc.startOffset, Math.min(loc.endOffset, loc.startOffset + 160)),
            detail: { tag, hasClosingTag: Boolean(loc.endTag) },
          },
        }),
      );
    }
    return out;
  },
});

define({
  meta: {
    id: 'WL-HTML-003',
    name: 'Obsolete script language attribute',
    version: '1.0.0',
    description: 'The language="JavaScript" attribute on <script> is obsolete; modern pages only need type or nothing.',
    language: 'html',
    category: 'HTML_COMPAT',
    defaultSeverity: 'LOW',
    defaultMigrationLevel: 'SAFE',
    basis: 'A <script> element carrying a language attribute whose value is not a VBScript dialect.',
    recipeId: 'RCP-SCRIPT-LANGUAGE',
    tags: ['obsolete-attribute'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const element of html.elements) {
      if ((element.tagName ?? '').toLowerCase() !== 'script') continue;
      const language = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'language');
      if (!language) continue;
      if (/vbscript|vbs/i.test(language.value)) continue; // handled by WL-HTML-004
      const loc = attributeLocation(element, 'language');
      if (!loc) continue;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          message: `Uses obsolete language="${language.value}" declaration`,
          risk:
            'Chrome ignores the attribute and still executes the script, so this is not a functional break by itself. It is reported because it marks script blocks written for IE-era conventions, which usually contain other compatibility issues worth reviewing.',
          recommendation: 'Remove the attribute and keep type="text/javascript" only when needed. Low priority: do not spend migration budget here first.',
          evidence: {
            kind: 'Attribute',
            matched: ctx.text.slice(loc.startOffset, loc.endOffset),
            detail: { attribute: 'language', value: language.value },
          },
        }),
      );
    }
    return out;
  },
});

define({
  meta: {
    id: 'WL-HTML-004',
    name: 'VBScript script block',
    version: '1.0.0',
    description: 'Script blocks written in VBScript. Chrome has no VBScript engine, so the block never executes.',
    language: 'html',
    category: 'ACTIVEX_VBSCRIPT',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'A <script> element whose language or type attribute declares vbscript / vbs.',
    tags: ['vbscript', 'blocker'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const element of html.elements) {
      if ((element.tagName ?? '').toLowerCase() !== 'script') continue;
      const declared = (element.attrs ?? [])
        .filter((a) => ['language', 'type'].includes(a.name.toLowerCase()))
        .map((a) => a.value)
        .join(' ');
      if (!/vbscript|vbs/i.test(declared)) continue;
      const loc = element.sourceCodeLocation;
      if (!loc) continue;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          message: 'Contains a VBScript code block',
          risk:
            'Chrome has no VBScript engine and will not execute the block at all. Unlike a missing DOM API, this produces no runtime error: the script is simply skipped, so every function defined inside is undefined when other code calls it.',
          recommendation:
            'Rewrite the VBScript logic in JavaScript by hand. Inspect what the block defines (functions, event handlers, MsgBox calls) and port it explicitly; automatic translation is unsafe for VBScript built-ins such as MsgBox, CreateObject, and On Error Resume Next.',
          evidence: {
            kind: 'ScriptBlock',
            matched: declared,
            detail: { declaredType: declared.trim() },
          },
        }),
      );
    }
    return out;
  },
});

define({
  meta: {
    id: 'WL-HTML-005',
    name: 'ActiveX control embed',
    version: '1.0.0',
    description: 'Embedded COM controls through <object classid="clsid:..."> or OLE <embed> types.',
    language: 'html',
    category: 'ACTIVEX_VBSCRIPT',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'An <object> whose classid starts with "clsid:", or an <embed> whose type is an OLE type.',
    tags: ['activex', 'blocker'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const element of html.elements) {
      const tag = (element.tagName ?? '').toLowerCase();
      if (tag !== 'object' && tag !== 'embed') continue;
      const classid = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'classid');
      const type = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'type');
      const isActiveX = Boolean(classid && /^\s*clsid:/i.test(classid.value));
      const isOle = Boolean(type && /x-oleobject|x-shockwave-flash|application\/x-ms/i.test(type.value));
      if (!isActiveX && !isOle) continue;
      const loc = element.sourceCodeLocation;
      if (!loc) continue;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          message: `Embeds an ActiveX/OLE control${classid ? ` (${classid.value.trim()})` : ''}`,
          risk:
            'Chrome cannot instantiate ActiveX controls. The element renders as an empty box, and any script that calls methods on it fails with "object does not support this property or method". The underlying capability (document signing, card readers, printers, Office preview) simply does not exist in the browser.',
          recommendation:
            'Treat as a migration blocker. Options: replace with a web-native viewer (PDF.js, Office Online), move the capability to a server-side service, ship a browser extension with Native Messaging, or retire the feature. Requires a product decision, not a code transformation.',
          evidence: {
            kind: 'Element',
            matched: ctx.text.slice(loc.startOffset, Math.min(loc.endOffset, loc.startOffset + 200)),
            detail: {
              tag,
              classid: classid?.value ?? null,
              mimeType: type?.value ?? null,
            },
          },
        }),
      );
    }
    return out;
  },
});

define({
  meta: {
    id: 'WL-HTML-006',
    name: 'IE-only attribute',
    version: '1.0.0',
    description: 'Attributes that only IE implements, such as dynsrc, lowsrc, datasrc and datafld.',
    language: 'html',
    category: 'HTML_COMPAT',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'Attribute names matched against a curated IE-only list, excluding the script language attribute handled separately.',
    tags: ['ie-only-attribute'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const element of html.elements) {
      const tag = (element.tagName ?? '').toLowerCase();
      for (const attr of element.attrs ?? []) {
        const name = attr.name.toLowerCase();
        if (name === 'language' && tag === 'script') continue;
        const explanation = IE_ONLY_ATTRIBUTES[name];
        if (!explanation) continue;
        const loc = attributeLocation(element, attr.name);
        if (!loc) continue;
        out.push(
          makeFinding(asRule(this), ctx, {
            startOffset: loc.startOffset,
            endOffset: loc.endOffset,
            message: `Uses IE-only attribute ${name} on <${tag}>`,
            risk: explanation,
            recommendation:
              'Remove the attribute and reimplement the behavior with standard DOM APIs. Verify the visual result, because these attributes typically carry layout or media behavior that Chrome silently drops.',
            evidence: {
              kind: 'Attribute',
              matched: ctx.text.slice(loc.startOffset, loc.endOffset),
              detail: { attribute: name, tag, value: attr.value.slice(0, 80) },
            },
          }),
        );
      }
    }
    return out;
  },
});

define({
  meta: {
    id: 'WL-HTML-007',
    name: 'XML data island',
    version: '1.0.0',
    description: 'Inline <xml> data islands used with IE data binding. Chrome does not parse them as data sources.',
    language: 'html',
    category: 'HTML_COMPAT',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'MANUAL',
    basis: 'An <xml> element in the document tree.',
    tags: ['data-binding', 'ie-only'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const element of html.elements) {
      if ((element.tagName ?? '').toLowerCase() !== 'xml') continue;
      const loc = element.sourceCodeLocation;
      if (!loc) continue;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          message: 'Contains an <xml> data island',
          risk:
            'Chrome treats <xml> as an unknown element, not as a data source. Any table bound to it through datasrc/datafld renders empty, and script that reads XMLDocument from it gets nothing. The page looks broken without any error.',
          recommendation:
            'Move the data to JSON (embedded or fetched) and render it with script. If the XML itself matters, parse it with DOMParser from a <script type="application/xml"> block.',
          evidence: {
            kind: 'Element',
            matched: ctx.text.slice(loc.startOffset, Math.min(loc.endOffset, loc.startOffset + 160)),
            detail: { id: (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'id')?.value ?? null },
          },
        }),
      );
    }
    return out;
  },
});

define({
  meta: {
    id: 'WL-HTML-008',
    name: 'X-UA-Compatible meta tag',
    version: '1.0.0',
    description: 'The IE document-mode switch is inert in Chrome but marks pages tuned for a specific IE rendering mode.',
    language: 'html',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'LOW',
    defaultMigrationLevel: 'SAFE',
    basis: 'A <meta http-equiv="X-UA-Compatible"> element.',
    recipeId: 'RCP-DROP-UA-COMPATIBLE',
    tags: ['document-mode'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const element of html.elements) {
      if ((element.tagName ?? '').toLowerCase() !== 'meta') continue;
      const httpEquiv = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'http-equiv');
      if (!httpEquiv || !/x-ua-compatible/i.test(httpEquiv.value)) continue;
      const loc = element.sourceCodeLocation;
      if (!loc) continue;
      const content = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'content')?.value ?? '';
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          message: `Declares an IE document mode (content="${content}")`,
          risk:
            'Chrome ignores X-UA-Compatible. The tag itself is harmless, but a page pinned to IE7/IE8 emulation usually relies on quirks-mode layout and legacy DOM behavior that Chrome reproduces differently, so layout and event handling need visual verification.',
          recommendation:
            'Remove the tag once the page runs on Chrome. Keep it during the transition if the page still must run on IE, and verify layout with the browser validation step rather than assuming equivalence.',
          evidence: {
            kind: 'Meta',
            matched: ctx.text.slice(loc.startOffset, loc.endOffset),
            detail: { content },
          },
        }),
      );
    }
    return out;
  },
});

define({
  meta: {
    id: 'WL-HTML-009',
    name: 'script for/event IE binding',
    version: '1.0.0',
    description: 'The IE-specific <script for="..." event="..."> syntax attaches handlers declaratively.',
    language: 'html',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'A <script> element that carries both a for and an event attribute.',
    tags: ['event', 'ie-only'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const html = ctx.parsed.html;
    if (!html) return out;
    for (const element of html.elements) {
      if ((element.tagName ?? '').toLowerCase() !== 'script') continue;
      const forAttr = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'for');
      const eventAttr = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'event');
      if (!forAttr || !eventAttr) continue;
      const loc = element.sourceCodeLocation;
      if (!loc) continue;
      out.push(
        makeFinding(asRule(this), ctx, {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          message: `Binds an event through <script for="${forAttr.value}" event="${eventAttr.value}">`,
          risk:
            'Chrome ignores for/event on <script>, so the handler body runs once at parse time instead of when the event fires. That usually throws immediately (the event object is undefined) or silently runs at the wrong moment.',
          recommendation:
            'Convert to addEventListener in a script that runs after the target exists, and move the handler body into a named function. Requires manual work because the target and timing both change.',
          evidence: {
            kind: 'ScriptBlock',
            matched: ctx.text.slice(loc.startOffset, Math.min(loc.endOffset, loc.startOffset + 160)),
            detail: { target: forAttr.value, event: eventAttr.value },
          },
        }),
      );
    }
    return out;
  },
});

export const htmlRules: RuleDraft[] = ruleList;
export { asRule, rawAttributeValue };
export type { P5Node };

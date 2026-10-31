import { findEnclosingParam, memberPath, walkJs, type JsNode } from '../../parser/jsParser.js';
import {
  collectInlineEventUnits,
  findMigratableHandlers,
  isInlineEventBinding,
} from '../handlers.js';
import type { FileContext, RawFinding, Rule, RuleDraft } from '../types.js';
import { makeFinding } from '../finding.js';

function eachNode(
  ctx: FileContext,
  visit: (node: JsNode, ancestors: JsNode[], unit: FileContext['parsed']['jsUnits'][number]) => void,
): void {
  for (const unit of ctx.parsed.jsUnits) {
    if (!unit.result.ast) continue;
    walkJs(unit.result.ast, (node, _parent, ancestors) => visit(node, ancestors, unit));
  }
}

function isIdent(node: JsNode | null | undefined, name: string): boolean {
  return Boolean(node && node.type === 'Identifier' && (node.name as string).toLowerCase() === name);
}

function propName(node: JsNode): string | null {
  if (node.type !== 'MemberExpression') return null;
  const prop = node.property as JsNode | undefined;
  if (!prop) return null;
  if (!node.computed && prop.type === 'Identifier') return prop.name as string;
  if (node.computed && prop.type === 'StringLiteral') return prop.value as string;
  return null;
}

const EVENTISH = /^(e|ev|evt|event|myevent|sender)$/i;

/** An object counts as an event when it is named like one AND is a parameter of the enclosing function, or the implicit event of an inline on* handler. */
function eventObjectConfidence(
  node: JsNode,
  ancestors: JsNode[],
  unit: FileContext['parsed']['jsUnits'][number],
): { isEvent: boolean; objectName: string | null } {
  const obj = node.object as JsNode | undefined;
  if (!obj) return { isEvent: false, objectName: null };
  if (obj.type !== 'Identifier') return { isEvent: false, objectName: memberPath(obj) };
  const name = obj.name as string;
  if (!EVENTISH.test(name)) return { isEvent: false, objectName: name };
  const isEvent = Boolean(findEnclosingParam(name, ancestors)) || isInlineEventBinding(unit, name);
  return { isEvent, objectName: name };
}

function calleeNamed(node: JsNode, name: string): boolean {
  if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return false;
  const callee = node.callee as JsNode | undefined;
  if (!callee) return false;
  if (isIdent(callee, name.toLowerCase())) return true;
  return callee.type === 'MemberExpression' && propName(callee) === name;
}

const ruleList: RuleDraft[] = [];

function define(draft: RuleDraft): void {
  ruleList.push(draft);
}

/* ------------------------------------------------------------------ *
 * Event model: attachEvent / detachEvent
 * ------------------------------------------------------------------ */

define({
  meta: {
    id: 'WL-JS-001',
    name: 'attachEvent binding',
    version: '1.0.0',
    description:
      'IE-specific element.attachEvent("on<event>", handler). Chrome does not implement it, so the call throws and the handler is never registered.',
    language: 'javascript',
    category: 'JS_API',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'CONDITIONAL',
    basis: 'AST match: CallExpression whose callee is a member expression with property name attachEvent.',
    recipeId: 'RCP-ATTACHEVENT',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || propName(callee) !== 'attachEvent') return;
      const args = (node.arguments as JsNode[]) ?? [];
      const eventArg = args[0];
      const handlerArg = args[1];
      const eventName = eventArg?.type === 'StringLiteral' ? (eventArg.value as string) : null;
      const convertible = Boolean(eventName && eventName.startsWith('on') && handlerArg);
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Calls IE-only attachEvent("${eventName ?? '?'}", ...)`,
          risk:
            'HTMLElement has no attachEvent in Chrome, so this throws "object.attachEvent is not a function" and the handler never runs. Every interaction that depends on it (click, submit, load callbacks) stops working.',
          recommendation: convertible
            ? 'Can be rewritten to addEventListener, but two semantics change: IE bound `this` to window while Chrome binds the element, and handlers that read window.event must take the event parameter instead.'
            : 'The event name is not a static "on<event>" string or the handler is missing, so it cannot be rewritten safely. Confirm the event name manually before switching to addEventListener.',
          migrationLevel: convertible ? 'CONDITIONAL' : 'MANUAL',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: {
              eventName: eventName ?? '(dynamic)',
              hasHandler: Boolean(handlerArg),
              objectPath: memberPath(callee.object as JsNode) ?? '(unknown)',
              argumentCount: args.length,
              touchesDynamicRegion: unit.dynamic,
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
    id: 'WL-JS-002',
    name: 'detachEvent unbinding',
    version: '1.0.0',
    description: 'IE-specific element.detachEvent("on<event>", handler). Chrome does not implement it.',
    language: 'javascript',
    category: 'JS_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'CONDITIONAL',
    basis: 'AST match: CallExpression whose callee property is detachEvent.',
    recipeId: 'RCP-DETACHEVENT',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || propName(callee) !== 'detachEvent') return;
      const args = (node.arguments as JsNode[]) ?? [];
      const eventName = args[0]?.type === 'StringLiteral' ? (args[0].value as string) : null;
      const convertible = Boolean(eventName?.startsWith('on') && args[1]);
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Calls IE-only detachEvent("${eventName ?? '?'}", ...)`,
          risk:
            'Chrome has no detachEvent, so the call throws. The subtler failure is a half-migrated file: binding moved to addEventListener while unbinding still uses detachEvent, so unbinding silently fails and handlers accumulate.',
          recommendation: convertible
            ? 'Rewrite to removeEventListener, verifying that the same function reference, the same event name without the "on" prefix, and the same capture flag are used. A mismatch makes removal a no-op.'
            : 'Arguments are not statically known. Verify the event name and handler reference manually before switching to removeEventListener.',
          migrationLevel: convertible ? 'CONDITIONAL' : 'MANUAL',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { eventName: eventName ?? '(dynamic)', argumentCount: args.length, touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

/* ------------------------------------------------------------------ *
 * window.event and legacy event-object properties
 * ------------------------------------------------------------------ */

define({
  meta: {
    id: 'WL-JS-003',
    name: 'window.event global',
    version: '1.0.0',
    description: 'Reads the IE-only global window.event to obtain the current event. It is always undefined in Chrome.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression whose object is window and property is event. Plain obj.event access does not match.',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const covered = new Set<number>();
    for (const handler of findMigratableHandlers(ctx)) {
      for (const start of handler.windowEventStarts) covered.add(start);
    }
    for (const inlineUnit of collectInlineEventUnits(ctx)) {
      for (const ref of inlineUnit.refs) covered.add(ref.start ?? -1);
    }
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression') return;
      if (memberPath(node) !== 'window.event') return;
      if (covered.has(node.start ?? -1)) return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Reads the IE-only window.event global',
          risk:
            'window.event does not exist in Chrome, so this expression is always undefined and any follow-up property access throws "Cannot read properties of undefined". The code usually sits inside a handler or timer, so it only fails when that path runs.',
          recommendation:
            'Take the event object from the handler parameter instead (el.addEventListener("click", function (e) { ... })). If the value is consumed in a timer or async callback, the event must be passed explicitly; that is a logic change, not an API swap.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0),
            container: unit.container,
            detail: { path: 'window.event', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-004',
    name: 'document.all',
    version: '1.0.0',
    description:
      'The legacy document.all collection. Chrome keeps it for compatibility, but it is falsy and not callable, so it cannot be used as an IE detector.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression with object document and property all.',
    tags: ['ie-only-api', 'feature-detection'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression') return;
      if (memberPath(node) !== 'document.all') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Uses the legacy document.all collection',
          risk:
            'Chrome intentionally keeps document.all as a falsy, non-callable object. The dangerous part is detection: `if (document.all)` is false in Chrome, so an IE branch test silently flips, while `document.all.length` or indexed access still appear to work. That mix makes the bug intermittent rather than obvious.',
          recommendation:
            'Replace feature detection with a capability check (typeof el.attachEvent === "function", or document.querySelector support) and replace collection access with querySelectorAll/getElementById. Do not keep document.all as a browser test.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0),
            container: unit.container,
            detail: { path: 'document.all', falsyInChrome: true, touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-005',
    name: 'document.createEventObject',
    version: '1.0.0',
    description: 'IE-specific synthetic event factory. Chrome removed it; the standard path is new Event / document.createEvent.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression with property createEventObject.',
    tags: ['event', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'createEventObject') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Creates a synthetic event with IE-only createEventObject()',
          risk:
            'createEventObject does not exist in Chrome, so the call throws before any handler runs. The IE event it produced also carried hand-assigned properties (type, srcElement, keyCode) that a standard Event will not accept: assigning unknown properties to a real event object is silently ignored.',
          recommendation:
            'Construct a real event (new Event("click", { bubbles: true }), new MouseEvent(...), or new CustomEvent for payloads) and dispatch it with dispatchEvent. Move any custom fields into CustomEvent detail. Manual rewrite; the property-assignment pattern must be redesigned.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0),
            container: unit.container,
            detail: { api: 'document.createEventObject', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-006',
    name: 'event.srcElement',
    version: '1.1.0',
    description: 'IE names the event target event.srcElement; the standard property is event.target.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'SAFE',
    basis:
      'AST match: MemberExpression with property srcElement. Only marked SAFE when the object is an event-like parameter of the enclosing function.',
    recipeId: 'RCP-SRCELEMENT',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'srcElement') return;
      // window.event.srcElement is fully covered by WL-JS-003; reporting both would double-count.
      if (memberPath(node.object as JsNode) === 'window.event') return;
      const { isEvent, objectName } = eventObjectConfidence(node, ancestors, unit);
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Uses IE-only ${objectName ?? 'event'}.srcElement`,
          risk:
            'Chrome event objects have no srcElement, so the value is undefined. Reading .id / .tagName / .value afterwards throws, while a plain equality comparison silently evaluates to false.',
          recommendation: isEvent
            ? 'The object is confirmed to be an event parameter, so it can be replaced with .target. Note that IE sometimes returned a text node; if the original logic inspects nodeType, verify that behaviour.'
            : 'The object cannot be confirmed as an event object, so .target would not be equivalent. Trace where it comes from before changing anything.',
          migrationLevel: isEvent ? 'SAFE' : 'MANUAL',
          confidence: isEvent ? 'CONFIRMED' : 'POSSIBLE',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0),
            container: unit.container,
            detail: {
              objectName: objectName ?? '(non-identifier)',
              objectIsEventParam: isEvent,
              touchesDynamicRegion: unit.dynamic,
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
    id: 'WL-JS-007',
    name: 'event.returnValue assignment',
    version: '1.0.0',
    description: 'IE cancels default behaviour by assigning event.returnValue; the standard call is event.preventDefault().',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'CONDITIONAL',
    basis: 'AST match: AssignmentExpression whose left side is a returnValue member and whose right side is a boolean literal.',
    recipeId: 'RCP-RETURNVALUE',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, ancestors, unit) => {
      if (node.type !== 'AssignmentExpression') return;
      const left = node.left as JsNode | undefined;
      const right = node.right as JsNode | undefined;
      if (!left || propName(left) !== 'returnValue') return;
      const { isEvent, objectName } = eventObjectConfidence(left, ancestors, unit);
      const boolValue = right?.type === 'BooleanLiteral' ? (right.value as boolean) : null;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `${objectName ?? 'event'}.returnValue = ${boolValue === null ? '(non-boolean)' : String(boolValue)} to cancel default behaviour`,
          risk:
            'Assigning returnValue does nothing in Chrome, so the link still navigates, the form still submits, and the context menu still opens. This is the classic "migration looks fine, behaviour quietly changed" defect.',
          recommendation:
            boolValue === false
              ? 'Rewrite to preventDefault(), after confirming the event is cancelable and the assignment happened before the handler returned. returnValue = true has no inverse; that case needs manual work.'
              : 'The assigned value is not a boolean literal, so the effect depends on runtime state. Confirm intent before rewriting or removing.',
          migrationLevel: boolValue === false && isEvent ? 'CONDITIONAL' : 'MANUAL',
          evidence: {
            kind: 'AssignmentExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: {
              assignedValue: boolValue === null ? '(non-literal)' : String(boolValue),
              objectName: objectName ?? '(non-identifier)',
              objectIsEventParam: isEvent,
              touchesDynamicRegion: unit.dynamic,
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
    id: 'WL-JS-008',
    name: 'event.cancelBubble assignment',
    version: '1.0.0',
    description: 'IE stops propagation with event.cancelBubble = true; the standard call is event.stopPropagation().',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'SAFE',
    basis: 'AST match: AssignmentExpression whose left side is a cancelBubble member and whose right side is a boolean literal.',
    recipeId: 'RCP-CANCELBUBBLE',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, ancestors, unit) => {
      if (node.type !== 'AssignmentExpression') return;
      const left = node.left as JsNode | undefined;
      const right = node.right as JsNode | undefined;
      if (!left || propName(left) !== 'cancelBubble') return;
      const { isEvent, objectName } = eventObjectConfidence(left, ancestors, unit);
      const boolValue = right?.type === 'BooleanLiteral' ? (right.value as boolean) : null;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `${objectName ?? 'event'}.cancelBubble = ${boolValue === null ? '(non-boolean)' : String(boolValue)} to stop propagation`,
          risk:
            'Chrome ignores assignments to cancelBubble, so the event keeps bubbling to parent handlers. The visible symptom is duplicated work: one click firing the parent handler twice, or two dialogs opening.',
          recommendation:
            boolValue === true
              ? 'Rewrite to stopPropagation(). If the same block also cancels the default action via returnValue, that must become preventDefault() as well; the two calls are not interchangeable.'
              : 'The right-hand side is not true, so it may be restoring state rather than stopping propagation. No equivalent standard API exists; review manually.',
          migrationLevel: boolValue === true && isEvent ? 'SAFE' : 'MANUAL',
          evidence: {
            kind: 'AssignmentExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: {
              assignedValue: boolValue === null ? '(non-literal)' : String(boolValue),
              objectName: objectName ?? '(non-identifier)',
              objectIsEventParam: isEvent,
              touchesDynamicRegion: unit.dynamic,
            },
          },
        }),
      );
    });
    return out;
  },
});

/* ------------------------------------------------------------------ *
 * Dialogs / selection / clipboard / ActiveX
 * ------------------------------------------------------------------ */

define({
  meta: {
    id: 'WL-JS-009',
    name: 'showModalDialog',
    version: '1.0.0',
    description: 'IE-specific synchronous modal dialog. Chrome removed it and offers no synchronous replacement.',
    language: 'javascript',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: CallExpression or NewExpression whose callee is showModalDialog (bare or member).',
    tags: ['dialog', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (!calleeNamed(node, 'showModalDialog')) return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Calls removed API showModalDialog',
          risk:
            'The API does not exist in Chrome, so the call throws. The deeper problem is control flow: showModalDialog was synchronous, and the next line could read window.returnValue immediately. Every replacement (window.open, <dialog>, iframe overlay) is asynchronous, so the calling code must be restructured.',
          recommendation:
            'Plan a manual rewrite: map each call site and its use of the return value, switch to window.open + postMessage or an in-page <dialog>, then convert the trailing synchronous logic to async. Do not emulate the blocking behaviour.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'showModalDialog', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-010',
    name: 'showModelessDialog',
    version: '1.0.0',
    description: 'IE-specific modeless dialog. Chrome does not support it.',
    language: 'javascript',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: CallExpression or NewExpression whose callee is showModelessDialog.',
    tags: ['dialog', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (!calleeNamed(node, 'showModelessDialog')) return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Calls IE-only showModelessDialog',
          risk:
            'Chrome does not implement the method, so the call throws. It also depends on the IE window model (dialogArguments, dialogWidth/dialogHeight), which has no equivalent.',
          recommendation:
            'Replace with window.open and explicit parent/child messaging, or with an in-page overlay. Manual rewrite only.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'showModelessDialog', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-011',
    name: 'document.selection',
    version: '1.0.0',
    description: 'IE-specific text selection object. The standard entry point is window.getSelection().',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression with object document and property selection.',
    tags: ['selection', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression') return;
      if (memberPath(node) !== 'document.selection') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Uses IE-only document.selection',
          risk:
            'document.selection is undefined in Chrome. The IE object also exposes createRange(), type and clear(), and the standard Selection/Range API does not map one-to-one, so renaming alone produces broken behaviour rather than an error.',
          recommendation:
            'Switch to window.getSelection() and translate each member: createRange() -> getRangeAt(0), text -> toString(), clear() -> removeAllRanges(). Anything that inserts markup (pasteHTML, execCommand) must be rewritten by hand.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0),
            container: unit.container,
            detail: { path: 'document.selection', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-012',
    name: 'window.clipboardData',
    version: '1.0.0',
    description: 'IE-specific synchronous clipboard access. Chrome requires the async Clipboard API.',
    language: 'javascript',
    category: 'JS_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'AST match: MemberExpression with object window and property clipboardData.',
    tags: ['clipboard', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression') return;
      if (memberPath(node) !== 'window.clipboardData') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Uses IE-only window.clipboardData',
          risk:
            'Chrome has no window.clipboardData. Its replacement, navigator.clipboard, is asynchronous, requires a user gesture and permissions, and is unavailable on plain http pages. The synchronous return value the old code relies on no longer exists.',
          recommendation:
            'Move to navigator.clipboard.writeText/readText and make the call site async, with a document.execCommand("copy") fallback for non-secure contexts. This changes control flow, so it is not automated in phase one.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0),
            container: unit.container,
            detail: { path: 'window.clipboardData', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-013',
    name: 'ActiveXObject',
    version: '1.0.0',
    description: 'Instantiates a COM component through new ActiveXObject(...). Chrome has no runtime for it.',
    language: 'javascript',
    category: 'ACTIVEX_VBSCRIPT',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'AST match: NewExpression or CallExpression whose callee identifier is ActiveXObject.',
    tags: ['activex', 'blocker'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (!calleeNamed(node, 'ActiveXObject')) return;
      const args = (node.arguments as JsNode[]) ?? [];
      const progId = args[0]?.type === 'StringLiteral' ? (args[0].value as string) : null;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Instantiates an ActiveX control${progId ? ` ${progId}` : ''}`,
          risk:
            'Chrome provides no ActiveX runtime, so this always fails. In practice the feature depends on local machine capabilities: file system access, serial ports, card readers, certificate stores, Office interop or vendor encryption controls. The whole capability is missing in Chrome, not just this API.',
          recommendation:
            'Record as a migration blocker and decide per case: move the capability to a server-side service, ship a browser extension with Native Messaging, adopt WebUSB/WebSerial/File System Access, or retire the feature. Phase one detects, locates and measures impact only.',
          evidence: {
            kind: 'NewExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: {
              progId: progId ?? '(built at runtime)',
              dynamicProgId: progId === null,
              touchesDynamicRegion: unit.dynamic,
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
    id: 'WL-JS-014',
    name: 'execScript',
    version: '1.0.0',
    description: 'IE-specific window.execScript evaluates a string in the global scope. Chrome does not support it.',
    language: 'javascript',
    category: 'JS_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'CONDITIONAL',
    basis: 'AST match: CallExpression whose callee property is execScript.',
    recipeId: 'RCP-EXECSCRIPT',
    tags: ['eval', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || propName(callee) !== 'execScript') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Calls IE-only execScript to evaluate a string',
          risk:
            'Chrome has no execScript. Replacing it with eval is not equivalent: execScript ran in the global scope while a direct eval inherits the caller scope, so variable declarations land in different places. Under a CSP without unsafe-eval both are blocked.',
          recommendation:
            'Remove the dynamic evaluation when possible. If it must stay, use indirect eval (0, eval)(code) to approximate global scope, and review the CSP impact. Manual change.',
          migrationLevel: ((node.arguments as JsNode[]) ?? []).length === 1 ? 'CONDITIONAL' : 'MANUAL',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'execScript', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-015',
    name: 'Conditional compilation (@cc_on)',
    version: '1.0.0',
    description: 'IE JScript conditional compilation directives (@cc_on / @if / @_jscript). Chrome treats them as comments.',
    language: 'javascript',
    category: 'ACTIVEX_VBSCRIPT',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'Text match for @cc_on, @_jscript and @if ( inside JavaScript sources; these directives only exist inside comments.',
    tags: ['jscript', 'blocker'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    const pattern = /@cc_on|@_jscript(?:_version)?\b|@if\s*\(/gi;
    for (const unit of ctx.parsed.jsUnits) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(unit.code)) !== null) {
        const absStart = unit.baseOffset + match.index;
        out.push(
          makeFinding(this as unknown as Rule, ctx, {
            startOffset: absStart,
            endOffset: absStart + match[0].length,
            message: `Uses JScript conditional compilation directive ${match[0]}`,
            risk:
              'Conditional compilation runs inside the IE JScript engine. Chrome sees only a comment, so the entire block guarded by @if never executes and nothing is reported. The functional loss is completely silent.',
            recommendation:
              'Review what the guarded block actually did (usually a browser patch), delete the IE branch and keep the standard branch. If both branches carry logic, merge them into one implementation. Not automated in phase one.',
            evidence: {
              kind: 'Directive',
              matched: match[0],
              container: unit.container,
              detail: { directive: match[0], touchesDynamicRegion: unit.dynamic },
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
    id: 'WL-JS-016',
    name: 'window.navigate',
    version: '1.0.0',
    description: 'IE-only window.navigate(url). Chrome removed it; location.assign is the equivalent.',
    language: 'javascript',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'CONDITIONAL',
    basis:
      'AST match: CallExpression calling window.navigate(...) or a bare navigate(...). Object methods named .navigate (routers) do not match.',
    recipeId: 'RCP-NAVIGATE',
    tags: ['navigation', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee) return;
      const isMember = callee.type === 'MemberExpression' && propName(callee) === 'navigate';
      const isBare = callee.type === 'Identifier' && String(callee.name ?? '').toLowerCase() === 'navigate';
      if (!isMember && !isBare) return;
      if (isMember) {
        const object = (callee as JsNode).object as JsNode | undefined;
        // router.navigate(...) is a framework call that works fine in Chrome.
        if (!object || object.type !== 'Identifier' || String(object.name) !== 'window') return;
      }
      const args = (node.arguments as JsNode[]) ?? [];
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Calls IE-only window.navigate(...)',
          risk:
            'Chrome has no window.navigate, so the call throws and the page never moves. The trap is that object methods named .navigate (Vue Router, React Router wrappers) are perfectly valid — only the window-level call is IE.',
          recommendation:
            'Replace with location.assign(url) to keep history behaviour, or location.replace(url) if the current page must not stay in the back stack. Confirm which one the old code relied on.',
          migrationLevel: args.length === 1 ? 'CONDITIONAL' : 'MANUAL',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { callee: isBare ? 'navigate' : 'window.navigate', argumentCount: args.length, touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-002',
    name: 'element.currentStyle',
    version: '1.0.0',
    description: 'IE-only computed style object. Chrome exposes getComputedStyle(element) instead.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression with property currentStyle on any object.',
    tags: ['computed-style', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'currentStyle') return;
      const object = (node.object as JsNode) ?? null;
      const objectText = object ? ctx.text.slice(object.start ?? 0, object.end ?? 0) : '';
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Reads IE-only ${objectText || 'element'}.currentStyle`,
          risk:
            'currentStyle does not exist in Chrome, so this expression is undefined and the following property read throws. It is also synchronous, while getComputedStyle returns a live object that must be read after layout — code that cached the object across a style change behaves differently.',
          recommendation:
            'Replace with getComputedStyle(element) and read the property from the returned object (getPropertyValue("width") for kebab-case names). If the value was cached and reused later, re-read it instead of holding the object.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { objectText: objectText || '(unknown)', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-003',
    name: 'styleSheet.rules',
    version: '1.0.0',
    description: 'IE exposed stylesheet rules as .rules; the standard property is .cssRules.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'CONDITIONAL',
    basis:
      'AST match: MemberExpression with property `rules` whose object expression looks like a stylesheet (styleSheet, .sheet, a bare `sheet`). config.rules does not match.',
    recipeId: 'RCP-CSSRULES',
    tags: ['stylesheet', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'rules') return;
      const object = node.object as JsNode | undefined;
      if (!object || typeof object.start !== 'number' || typeof object.end !== 'number') return;
      const objectText = ctx.text.slice(object.start, object.end);
      // Guard against every other object that happens to have a `rules` property. A bare
      // variable named `sheet` is included because `var sheet = document.styleSheets[0]`
      // followed by `sheet.rules` is the shape this pattern actually appears in.
      if (!/styleSheet|\.sheet\b|(^|\.)sheet$/i.test(objectText.trim())) return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Reads ${objectText}.rules on a stylesheet`,
          risk:
            'IE exposed a stylesheet rules collection as .rules; Chrome only knows .cssRules. The expression is undefined, so the following .length or index access throws, and code that enumerates rules to patch or read them stops working.',
          recommendation:
            'Rename to .cssRules. Both collections expose the same CSSRule objects, but cross-origin stylesheets throw on access instead of returning an empty list, so keep any existing try/catch.',
          migrationLevel: 'CONDITIONAL',
          confidence: 'POSSIBLE',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { objectText: objectText.slice(0, 120), touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-004',
    name: 'document.execCommand',
    version: '1.0.0',
    description: 'Deprecated editing command API. It still runs in Chrome, but its behaviour is uneven and removal is planned.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'LOW',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: CallExpression whose callee is document.execCommand (bare calls are not assumed to be the DOM API).',
    tags: ['deprecated', 'editing'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || memberPath(callee) !== 'document.execCommand') return;
      const args = (node.arguments as JsNode[]) ?? [];
      const command = args[0]?.type === 'StringLiteral' ? String(args[0].value) : null;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Calls deprecated document.execCommand("${command ?? '?'}")`,
          risk:
            'execCommand still exists in Chrome, so this does not throw — which is why it survives migrations and fails later. The behaviour is uneven: cut/copy/paste need a user gesture and return false otherwise, insertHTML sanitises differently from IE, and the API is deprecated with no replacement for every command.',
          recommendation:
            'Replace per command: clipboard operations with navigator.clipboard, formatting with Range/Selection APIs or a small editor library. Until then, check the boolean return value instead of assuming success.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { command: command ?? '(dynamic)', argumentCount: args.length, touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-BEH-002',
    name: 'navigator.appName IE check',
    version: '1.0.0',
    description: 'Reading navigator.appName to detect IE. Chrome reports "Netscape", so the branches that depend on it flip.',
    language: 'javascript',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression navigator.appName. UA string literals are handled by WL-BEH-001 instead.',
    tags: ['ua-sniffing', 'behavior'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression') return;
      // memberPath only resolves a known set of roots (document, window, ...) and reports
      // everything else as "*", so the object and property are checked explicitly here.
      const object = node.object as JsNode | undefined;
      if (!object || object.type !== 'Identifier' || String(object.name) !== 'navigator') return;
      if (propName(node) !== 'appName') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Reads navigator.appName to identify the browser',
          risk:
            'navigator.appName returns "Netscape" in every Chromium browser, so any comparison against "Microsoft Internet Explorer" is always false. When this guards a feature, the feature is skipped without an error; when it guards a workaround, the workaround is silently dropped.',
          recommendation:
            'Delete the check and keep the branch that should run, or replace it with feature detection for the capability the branch actually needs. Do not substitute a different user-agent test.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0),
            container: unit.container,
            detail: { path: 'navigator.appName', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

/* ------------------------------------------------------------------ *
 * DOM and browser behavior
 * ------------------------------------------------------------------ */

define({
  meta: {
    id: 'WL-DOM-001',
    name: 'element.fireEvent',
    version: '1.0.0',
    description: 'IE-specific event dispatch. The standard call is element.dispatchEvent(new Event(...)).',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'CONDITIONAL',
    basis: 'AST match: CallExpression whose callee property is fireEvent.',
    recipeId: 'RCP-FIREEVENT',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || propName(callee) !== 'fireEvent') return;
      const args = (node.arguments as JsNode[]) ?? [];
      const eventName = args[0]?.type === 'StringLiteral' ? (args[0].value as string) : null;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Calls IE-only fireEvent("${eventName ?? '?'}")`,
          risk:
            'Chrome has no fireEvent, so the call throws. Dispatch also differs: the event object must be constructed explicitly, and whether it bubbles changes which handlers run.',
          recommendation: `Replace with dispatchEvent(new Event("${eventName?.replace(/^on/, '') ?? 'event'}", { bubbles: true, cancelable: true })) and decide the bubbling flag deliberately; use CustomEvent when the handler needs data.`,
          migrationLevel: args.length === 1 && eventName?.startsWith('on') ? 'CONDITIONAL' : 'MANUAL',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { eventName: eventName ?? '(dynamic)', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-BEH-001',
    name: 'IE user-agent sniffing',
    version: '1.0.0',
    description: 'Code branches on MSIE / Trident user-agent strings, which never match in Chrome.',
    language: 'javascript',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: a string literal whose value matches IE UA markers. Identical text inside comments does not match.',
    tags: ['ua-sniffing', 'behavior'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      // UA sniffing appears both as a string comparison and as a regex literal
      // (/MSIE (\d+\.\d+)/), so both node kinds are inspected.
      const isRegex = node.type === 'RegExpLiteral';
      if (!isRegex && node.type !== 'StringLiteral') return;
      const value = isRegex ? String(node.pattern ?? '') : String(node.value ?? '');
      const matches = isRegex
        ? /MSIE|Trident\/|rv:\s*\d/i.test(value)
        : /MSIE\s*\d|Trident\/|Windows\s+NT\s+[\d.]+;\s*.*rv:/i.test(value);
      if (!matches) return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Sniffs the IE version from the user-agent string',
          risk:
            'Chrome\'s user agent contains neither MSIE nor Trident, so every isIE check returns false. If the structure is "if (isIE) { main logic }", the whole feature is skipped without an error; if it is "if (isIE) { patch } else { logic }", the result may accidentally be correct. Each site must be read individually.',
          recommendation:
            'Drop UA sniffing and use feature detection (typeof obj.attachEvent === "function") or a single standard implementation. Confirm whether the branch content is still needed on Chrome.',
          evidence: {
            kind: isRegex ? 'RegExpLiteral' : 'StringLiteral',
            matched: value.slice(0, 120),
            container: unit.container,
            detail: { uaPattern: value.slice(0, 60), touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-005',
    name: 'element.runtimeStyle',
    version: '1.0.0',
    description: 'IE-only writable runtime style object. Chrome reads computed values through getComputedStyle and writes through element.style.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression with property runtimeStyle on any object.',
    tags: ['computed-style', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'runtimeStyle') return;
      const object = (node.object as JsNode) ?? null;
      const objectText = object ? ctx.text.slice(object.start ?? 0, object.end ?? 0) : '';
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Uses IE-only ${objectText || 'element'}.runtimeStyle`,
          risk:
            'runtimeStyle does not exist in Chrome, so reads return undefined and writes are ignored or throw. IE used it to override the cascade without touching the inline style object; the two concepts are not interchangeable.',
          recommendation:
            'Read computed values with getComputedStyle(element); write overrides with element.style.setProperty(name, value, priority). Check whether the code needed a cascade override or an ordinary inline style before choosing.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { objectText: objectText || '(unknown)', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-006',
    name: 'document.createStyleSheet',
    version: '1.0.0',
    description: 'IE-only API for adding a stylesheet at runtime. Chrome creates a style or link element instead.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: CallExpression whose callee is document.createStyleSheet.',
    tags: ['stylesheet', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || callee.type !== 'MemberExpression' || propName(callee) !== 'createStyleSheet') return;
      const object = callee.object as JsNode | undefined;
      if (!object || object.type !== 'Identifier' || object.name !== 'document') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Calls IE-only document.createStyleSheet()',
          risk:
            'document.createStyleSheet is absent in Chrome, so the call throws and the stylesheet is never inserted. The returned object was also mutable in ways a standard CSSStyleSheet is not.',
          recommendation:
            'Create a <style> element, set its textContent (or a <link rel="stylesheet"> for a URL), append it to <head>, and use the standard sheet API when the code needs to address rules later.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'document.createStyleSheet', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-007',
    name: 'element.setCapture',
    version: '1.0.0',
    description: 'IE-only mouse capture API. Chrome uses Pointer Events and setPointerCapture with a pointer id.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: CallExpression whose callee property is setCapture or releaseCapture.',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || callee.type !== 'MemberExpression') return;
      const method = propName(callee);
      if (method !== 'setCapture' && method !== 'releaseCapture') return;
      const object = callee.object as JsNode | undefined;
      const objectText = object ? ctx.text.slice(object.start ?? 0, object.end ?? 0) : '';
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Calls IE-only ${objectText || 'element'}.${method}()`,
          risk:
            'setCapture and releaseCapture do not exist in Chrome, so mouse capture silently fails: dragging outside the element stops delivering events. The standard pointer capture API is keyed by pointerId and fires different events.',
          recommendation:
            'Move the interaction to Pointer Events: call setPointerCapture(event.pointerId) in pointerdown and release it on pointerup or lostpointercapture. Verify the drag logic still receives the coordinates it expects.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { method, objectText: objectText || '(unknown)', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-008',
    name: 'event.toElement / fromElement',
    version: '1.0.0',
    description: 'IE-only mouse event properties. Chrome exposes relatedTarget, with different semantics for some event types.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression toElement or fromElement on a parameter named like an event.',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, ancestors, unit) => {
      if (node.type !== 'MemberExpression') return;
      const api = propName(node);
      if (api !== 'toElement' && api !== 'fromElement') return;
      const confidence = eventObjectConfidence(node, ancestors, unit);
      if (!confidence.isEvent) return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Reads IE-only ${confidence.objectName}.${api}`,
          risk:
            'toElement and fromElement are undefined in Chrome, so the comparison sees null and hover logic stops working. relatedTarget is the standard replacement, but it is only meaningful for mouseover/mouseout and focus events, and IE distinguished the direction differently.',
          recommendation:
            'Replace with event.relatedTarget and branch on event.type (mouseover vs mouseout). Null is normal when the pointer entered or left the document; confirm the old code treated that case the same way.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api, objectName: confidence.objectName ?? '(unknown)', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-009',
    name: 'document.frames',
    version: '1.0.0',
    description: 'IE-only collection of frame windows. Chrome exposes window.frames instead.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression with property frames whose object is the document identifier.',
    tags: ['frames', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'frames') return;
      const object = node.object as JsNode | undefined;
      if (!object || object.type !== 'Identifier' || object.name !== 'document') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Uses IE-only document.frames',
          risk:
            'document.frames is undefined in Chrome, so indexing or reading length throws. window.frames is the standard collection, but named access and cross-origin rules differ.',
          recommendation:
            'Use window.frames (or document.querySelectorAll("iframe") when you need the elements). Check whether the code relied on name lookup, numeric indexes or cross-frame function calls, and test with the frames loaded.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'document.frames', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-010',
    name: 'document.recalc',
    version: '1.0.0',
    description: 'IE-only forced layout API. Chrome recalculates layout when a layout property is read.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'LOW',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: CallExpression whose callee is document.recalc.',
    tags: ['layout', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || callee.type !== 'MemberExpression' || propName(callee) !== 'recalc') return;
      const object = callee.object as JsNode | undefined;
      if (!object || object.type !== 'Identifier' || object.name !== 'document') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Calls IE-only document.recalc()',
          risk:
            'document.recalc does not exist in Chrome and the call throws. Its purpose was to force layout before measuring; Chrome flushes layout when a layout property is read, so the explicit call is usually unnecessary.',
          recommendation:
            'Remove the call and read the layout property that the following code needs (offsetWidth, getBoundingClientRect). If the code depended on timing, move the measurement into requestAnimationFrame and compare the visual result.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'document.recalc', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-BEH-003',
    name: 'window.showHelp',
    version: '1.0.0',
    description: 'Removed IE help window API. Chrome has no in-browser replacement for it.',
    language: 'javascript',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'AST match: CallExpression or NewExpression calling window.showHelp or a bare showHelp.',
    tags: ['help', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee) return;
      const isBare = callee.type === 'Identifier' && String(callee.name ?? '').toLowerCase() === 'showhelp';
      const isWindow =
        callee.type === 'MemberExpression' &&
        propName(callee) === 'showHelp' &&
        (callee.object as JsNode | undefined)?.type === 'Identifier' &&
        ((callee.object as JsNode).name as string) === 'window';
      if (!isBare && !isWindow) return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Calls removed API window.showHelp()',
          risk:
            'window.showHelp was removed with IE and does not exist in Chrome, so the call throws and the help window never opens. There is no built-in replacement for the WinHelp format.',
          recommendation:
            'Decide where the help content lives now: open a maintained HTML help page with window.open, or route to an in-app help panel. Confirm the content is still available before removing the entry point.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'window.showHelp', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-BEH-004',
    name: 'window.createPopup',
    version: '1.0.0',
    description: 'Removed IE popup API. Chrome builds the same UI from positioned elements or dialog elements.',
    language: 'javascript',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'AST match: CallExpression or NewExpression calling window.createPopup or a bare createPopup.',
    tags: ['popup', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee) return;
      const isBare = callee.type === 'Identifier' && String(callee.name ?? '').toLowerCase() === 'createpopup';
      const isWindow =
        callee.type === 'MemberExpression' &&
        propName(callee) === 'createPopup' &&
        (callee.object as JsNode | undefined)?.type === 'Identifier' &&
        ((callee.object as JsNode).name as string) === 'window';
      if (!isBare && !isWindow) return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Calls removed API window.createPopup()',
          risk:
            'window.createPopup was removed with IE, so the call throws and any menu built on top of it never appears. The IE popup was clipped to the viewport and dismissed on outside clicks by the browser.',
          recommendation:
            'Rebuild the UI as a positioned element or a <dialog>; implement outside-click dismissal and viewport clamping explicitly. Confirm keyboard focus and stacking order match the old behaviour.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'window.createPopup', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-011',
    name: 'IE propertychange event',
    version: '1.0.0',
    description: 'IE-only propertychange event and event.propertyName. Chrome reports DOM changes through MutationObserver.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: event-parameter .propertyName, or any .onpropertychange member.',
    tags: ['event', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, ancestors, unit) => {
      if (node.type !== 'MemberExpression') return;
      const api = propName(node);
      if (api === 'propertyName') {
        const confidence = eventObjectConfidence(node, ancestors, unit);
        if (!confidence.isEvent) return;
        out.push(
          makeFinding(this as unknown as Rule, ctx, {
            variant: 'propertyName',
            startOffset: node.start ?? 0,
            endOffset: node.end ?? 0,
            message: `Reads IE-only ${confidence.objectName}.propertyName`,
            risk:
              'propertyName only exists on IE propertychange events. Chrome never fires propertychange, so the handler that reads it never runs and the UI that depended on the change stays stale without an error.',
            recommendation:
              'Observe the element or subtree with MutationObserver. Map record.attributeName (or record.type for a childList observer) to the logic the propertychange handler performed, and verify the initial state is applied separately.',
            evidence: {
              kind: 'MemberExpression',
              matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
              container: unit.container,
              detail: { api: 'propertyName', objectName: confidence.objectName ?? '(unknown)', touchesDynamicRegion: unit.dynamic },
            },
          }),
        );
        return;
      }
      if (api === 'onpropertychange') {
        const object = (node.object as JsNode) ?? null;
        const objectText = object ? ctx.text.slice(object.start ?? 0, object.end ?? 0) : '';
        out.push(
          makeFinding(this as unknown as Rule, ctx, {
            variant: 'onpropertychange',
            startOffset: node.start ?? 0,
            endOffset: node.end ?? 0,
            message: `Uses IE-only ${objectText || 'element'}.onpropertychange`,
            risk:
              'Chrome does not implement the propertychange event, so assigning onpropertychange registers nothing and the handler never runs. There is no error; the missing updates are silent.',
            recommendation:
              'Replace the handler with a MutationObserver on the element or subtree, translate attribute changes to the old property logic, and remove the IE assignment.',
            evidence: {
              kind: 'MemberExpression',
              matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
              container: unit.container,
              detail: { api: 'onpropertychange', objectText: objectText || '(unknown)', touchesDynamicRegion: unit.dynamic },
            },
          }),
        );
      }
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-012',
    name: 'element.addBehavior',
    version: '1.0.0',
    description: 'IE-only HTC behavior attachment. Chrome has no addBehavior and does not load .htc files.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'AST match: CallExpression whose callee property is addBehavior or removeBehavior.',
    tags: ['behavior', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || callee.type !== 'MemberExpression') return;
      const method = propName(callee);
      if (method !== 'addBehavior' && method !== 'removeBehavior') return;
      const object = callee.object as JsNode | undefined;
      const objectText = object ? ctx.text.slice(object.start ?? 0, object.end ?? 0) : '';
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Calls IE-only ${objectText || 'element'}.${method}()`,
          risk:
            'HTC behaviors and addBehavior are IE-only. In Chrome the method is undefined, so the call throws and none of the behavior code loads; any event wiring or rendering it performed is gone.',
          recommendation:
            'Move the behavior implementation into a normal JavaScript module or custom element, attach its listeners explicitly, and port its CSS. Test the interaction that depended on the behavior, not just page load.',
          evidence: {
            kind: 'CallExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: method, method, objectText: objectText || '(unknown)', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-013',
    name: 'document.namespaces',
    version: '1.0.0',
    description: 'IE-only namespace registration used for VML and other non-standard markup. Chrome has no such API.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'UNSUPPORTED',
    basis: 'AST match: MemberExpression with property namespaces whose object is the document identifier.',
    tags: ['namespace', 'removed-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'namespaces') return;
      const object = node.object as JsNode | undefined;
      if (!object || object.type !== 'Identifier' || object.name !== 'document') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Uses IE-only document.namespaces',
          risk:
            'document.namespaces is undefined in Chrome, so the call throws. It was used to register VML or other IE-only XML dialects; even if the namespace were registered, Chrome would not render that markup.',
          recommendation:
            'Replace the feature with SVG or canvas (or a library built on them). There is no namespace equivalent to port to; treat this as a capability decision and verify the rendered output.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'document.namespaces', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-DOM-014',
    name: 'element.styleSheet',
    version: '1.0.0',
    description: 'IE-only stylesheet object on style and link elements. Chrome exposes element.sheet instead.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'MEDIUM',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression with property styleSheet, excluding the styleSheet.rules chain handled separately.',
    tags: ['stylesheet', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'styleSheet') return;
      const parent = ancestors[ancestors.length - 1];
      if (parent?.type === 'MemberExpression' && propName(parent) === 'rules') return;
      const object = node.object as JsNode | undefined;
      const objectText = object ? ctx.text.slice(object.start ?? 0, object.end ?? 0) : '';
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: `Reads IE-only ${objectText || 'element'}.styleSheet`,
          risk:
            'element.styleSheet is undefined in Chrome, so the following access throws. Chrome exposes the CSSOM through element.sheet on <style> and <link> elements; the object shape is similar but not identical.',
          recommendation:
            'Read element.sheet instead, confirm the element is a style or link element, and adjust CSSOM calls (insertRule/deleteRule, cssRules) to the standard interface.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'styleSheet', objectText: objectText || '(unknown)', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-BEH-005',
    name: 'window.offscreenBuffering',
    version: '1.0.0',
    description: 'IE-only rendering performance hint. Chrome ignores the property; it neither throws nor buffers offscreen.',
    language: 'javascript',
    category: 'BROWSER_BEHAVIOR',
    defaultSeverity: 'LOW',
    defaultMigrationLevel: 'MANUAL',
    basis: 'AST match: MemberExpression with property offscreenBuffering whose object is the window identifier.',
    tags: ['performance', 'ie-only-api'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    eachNode(ctx, (node, _ancestors, unit) => {
      if (node.type !== 'MemberExpression' || propName(node) !== 'offscreenBuffering') return;
      const object = node.object as JsNode | undefined;
      if (!object || object.type !== 'Identifier' || object.name !== 'window') return;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: node.start ?? 0,
          endOffset: node.end ?? 0,
          message: 'Uses IE-only window.offscreenBuffering',
          risk:
            'Chrome ignores window.offscreenBuffering. It does not throw, but the offscreen buffering the code requested never happens, so any rendering workaround that relied on it is silently absent.',
          recommendation:
            'Remove the assignment. If it was added to fix a perceived performance problem, measure the interaction after removal and address the actual cost instead of porting the hint.',
          evidence: {
            kind: 'MemberExpression',
            matched: ctx.text.slice(node.start ?? 0, node.end ?? 0).slice(0, 200),
            container: unit.container,
            detail: { api: 'window.offscreenBuffering', touchesDynamicRegion: unit.dynamic },
          },
        }),
      );
    });
    return out;
  },
});

define({
  meta: {
    id: 'WL-JS-017',
    name: 'IE event handler signature',
    version: '1.4.0',
    description: 'Handler that reads window.event. Chrome passes the event first; existing parameters are kept when every call site is an inline on* call.',
    language: 'javascript',
    category: 'JS_API',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'CONDITIONAL',
    basis: 'AST match: function reading window.event; by-reference registrations, inline on* calls, or cross-file calls; parameters only with inline-only call sites.',
    recipeId: 'RCP-HANDLER-EVENT-PARAM',
    tags: ['event', 'window-event', 'handler'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    for (const handler of findMigratableHandlers(ctx)) {
      const count = handler.windowEventNodes.length;
      const inlineCount = handler.inlineCallCount;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          variant: inlineCount > 0 ? 'inline' : undefined,
          startOffset: handler.start,
          endOffset: handler.signatureEnd,
          message:
            inlineCount > 0
              ? `IE event handler ${handler.name} uses window.event (${count} reference${count === 1 ? '' : 's'}, ${inlineCount} inline call${inlineCount === 1 ? '' : 's'})`
              : `IE event handler ${handler.name} uses window.event (${count} reference${count === 1 ? '' : 's'})`,
          risk:
            'The handler reads the IE-only window.event global. Chrome passes the event object as the first handler argument, so this handler throws on its first event unless the reference is rewritten. The transform is mechanical but changes the function signature.',
          recommendation:
            'Migrate this finding to add the event parameter and replace every window.event reference in the handler. Rescan afterwards: the srcElement, returnValue and cancelBubble reads then satisfy their own recipes. The attachEvent registration still needs its separate migration.',
          evidence: {
            kind: 'Function',
            matched: ctx.text.slice(handler.start, handler.signatureEnd),
            container: handler.container,
            detail: {
              handler: handler.name,
              registration: handler.registration,
              windowEventCount: count,
              inlineCallCount: inlineCount,
              paramCount: handler.paramCount,
              inlineInDefinitionFile: inlineCount > 0,
              handlerStart: handler.start,
              handlerEnd: handler.end,
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
    id: 'WL-JS-018',
    name: 'window.event in an inline handler attribute',
    version: '1.0.0',
    description:
      'An inline on* attribute reads the IE-only window.event. Modern inline handlers already receive the event object as event.',
    language: 'javascript',
    category: 'DOM_API',
    defaultSeverity: 'HIGH',
    defaultMigrationLevel: 'CONDITIONAL',
    basis:
      'AST match: window.event inside an on* attribute value, excluding dynamic units, nested functions, shadowing event bindings, and assignment/delete/typeof uses.',
    recipeId: 'RCP-INLINE-HANDLER-EVENT',
    tags: ['event', 'window-event', 'inline-handler'],
  },
  detect(ctx) {
    const out: RawFinding[] = [];
    for (const inlineUnit of collectInlineEventUnits(ctx)) {
      const first = inlineUnit.refs[0];
      const count = inlineUnit.refs.length;
      out.push(
        makeFinding(this as unknown as Rule, ctx, {
          startOffset: first?.start ?? inlineUnit.start,
          endOffset: first?.end ?? inlineUnit.end,
          message: `Inline ${inlineUnit.eventName} handler reads window.event (${count} reference${count === 1 ? '' : 's'})`,
          risk:
            'window.event does not exist in Chrome, so the attribute throws as soon as the event fires. Inline handlers already receive the standard event object under the name event, so no signature or call-site change is needed.',
          recommendation:
            'Migrate this finding to replace every window.event reference in the attribute with event. Rescan afterwards: the srcElement, returnValue and cancelBubble reads on the inline event then satisfy their own recipes. window.event in script blocks still needs a handler parameter.',
          evidence: {
            kind: 'Attribute',
            matched: ctx.text.slice(inlineUnit.start, inlineUnit.end).slice(0, 200),
            container: inlineUnit.unit.container,
            detail: {
              attribute: inlineUnit.eventName,
              windowEventCount: count,
              windowEventStarts: inlineUnit.refs.map((ref) => ref.start ?? -1).join(','),
              inlineStart: inlineUnit.start,
              inlineEnd: inlineUnit.end,
            },
          },
        }),
      );
    }
    return out;
  },
});

export const jsRules: RuleDraft[] = ruleList;
export { eachNode, propName, isIdent, calleeNamed, eventObjectConfidence };
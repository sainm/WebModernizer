import { findEnclosingParam, walkJs, type JsNode } from '../parser/jsParser.js';
import type { ParsedFile } from '../parser/index.js';
import type { AnalysisFinding, TextEdit } from '../model/types.js';
import type { PreconditionResult, Recipe, RecipeContext } from './types.js';

interface NodeHit {
  node: JsNode;
  ancestors: JsNode[];
}

/**
 * Locates the AST node that exactly covers the finding range.
 * Offsets in the AST are file-absolute (see shiftOffsets in jsParser), so the
 * range from the finding can be compared directly.
 */
export function findNodeByRange(parsed: ParsedFile, start: number, end: number): NodeHit | null {
  let best: NodeHit | null = null;
  for (const unit of parsed.jsUnits) {
    if (!unit.result.ast) continue;
    walkJs(unit.result.ast, (node, _parent, ancestors) => {
      if (node.start !== start || node.end !== end) return;
      // Prefer the innermost node when ranges coincide (e.g. a parenthesized wrapper).
      if (!best || ancestors.length > best.ancestors.length) best = { node, ancestors };
    });
  }
  return best;
}

function propIdent(node: JsNode | undefined): JsNode | null {
  if (!node || node.type !== 'MemberExpression' || node.computed) return null;
  const prop = node.property as JsNode | undefined;
  return prop && prop.type === 'Identifier' ? prop : null;
}

function objectText(node: JsNode, ctx: RecipeContext): string | null {
  const obj = node.object as JsNode | undefined;
  if (!obj || typeof obj.start !== 'number' || typeof obj.end !== 'number') return null;
  return ctx.text.slice(obj.start, obj.end);
}

function isEventObject(node: JsNode, ancestors: JsNode[]): { ok: boolean; name: string | null } {
  const obj = node.object as JsNode | undefined;
  if (!obj || obj.type !== 'Identifier') return { ok: false, name: null };
  const name = obj.name as string;
  return { ok: Boolean(findEnclosingParam(name, ancestors)), name };
}

function quotedLike(raw: string, value: string): string {
  const quote = raw.startsWith("'") ? "'" : '"';
  return `${quote}${value}${quote}`;
}

const srcElementRecipe: Recipe = {
  id: 'RCP-SRCELEMENT',
  name: 'event.srcElement -> event.target',
  version: '1.1.0',
  ruleIds: ['WL-JS-006'],
  level: 'SAFE',
  summary: 'Renames the property access on an event parameter from srcElement to target.',
  caveats: [
    'IE could return a text node from srcElement; Chrome always returns an element. Code that inspects nodeType must be reviewed.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return { ok: false, reasons: ['The matched node no longer exists at this position; re-scan the file.'] };
    const prop = propIdent(hit.node);
    if (!prop || prop.name !== 'srcElement') {
      return { ok: false, reasons: ['The code has changed: the member is no longer .srcElement.'] };
    }
    const event = isEventObject(hit.node, hit.ancestors);
    if (!event.ok) {
      return {
        ok: false,
        reasons: [
          `The object "${event.name ?? '?'}" is not a parameter of the enclosing function, so .target is not provably equivalent.`,
        ],
      };
    }
    return { ok: true, reasons: [] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const prop = propIdent(hit.node);
    if (!prop || typeof prop.start !== 'number' || typeof prop.end !== 'number') return null;
    return [
      {
        start: prop.start,
        end: prop.end,
        newText: 'target',
        ruleId: 'WL-JS-006',
        reason: 'srcElement is IE-only; target is the standard property on event objects.',
      },
    ];
  },
};

const cancelBubbleRecipe: Recipe = {
  id: 'RCP-CANCELBUBBLE',
  name: 'event.cancelBubble = true -> event.stopPropagation()',
  version: '1.0.0',
  ruleIds: ['WL-JS-008'],
  level: 'SAFE',
  summary: 'Replaces the assignment with a stopPropagation() call on the same object.',
  caveats: ['If the handler also cancelled the default action via returnValue, convert that separately with preventDefault().'],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit || hit.node.type !== 'AssignmentExpression') {
      return { ok: false, reasons: ['The matched statement is no longer an assignment at this position.'] };
    }
    const left = hit.node.left as JsNode | undefined;
    const right = hit.node.right as JsNode | undefined;
    const prop = propIdent(left);
    if (!prop || prop.name !== 'cancelBubble') return { ok: false, reasons: ['Left side is no longer .cancelBubble.'] };
    if (right?.type !== 'BooleanLiteral' || right.value !== true) {
      return { ok: false, reasons: ['cancelBubble is not assigned the literal true, so stopPropagation() is not equivalent.'] };
    }
    const event = isEventObject(left as JsNode, hit.ancestors);
    if (!event.ok) return { ok: false, reasons: ['The object is not an event parameter of the enclosing function.'] };
    return { ok: true, reasons: [] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const left = hit.node.left as JsNode | undefined;
    if (!left) return null;
    const obj = objectText(left, ctx);
    if (!obj || typeof hit.node.start !== 'number' || typeof hit.node.end !== 'number') return null;
    return [
      {
        start: hit.node.start,
        end: hit.node.end,
        newText: `${obj}.stopPropagation()`,
        ruleId: 'WL-JS-008',
        reason: 'Chrome ignores cancelBubble; stopPropagation() is the standard equivalent.',
      },
    ];
  },
};

const returnValueRecipe: Recipe = {
  id: 'RCP-RETURNVALUE',
  name: 'event.returnValue = false -> event.preventDefault()',
  version: '1.0.0',
  ruleIds: ['WL-JS-007'],
  level: 'CONDITIONAL',
  summary: 'Replaces the assignment with preventDefault() on the same event object.',
  caveats: [
    'Only equivalent for cancelable events; verify the listener is not passive.',
    'preventDefault() must run before the handler returns, and returnValue = true has no inverse.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit || hit.node.type !== 'AssignmentExpression') {
      return { ok: false, reasons: ['The matched statement is no longer an assignment at this position.'] };
    }
    const left = hit.node.left as JsNode | undefined;
    const right = hit.node.right as JsNode | undefined;
    const prop = propIdent(left);
    if (!prop || prop.name !== 'returnValue') return { ok: false, reasons: ['Left side is no longer .returnValue.'] };
    if (right?.type !== 'BooleanLiteral' || right.value !== false) {
      return { ok: false, reasons: ['Only returnValue = false maps to preventDefault().'] };
    }
    const event = isEventObject(left as JsNode, hit.ancestors);
    if (!event.ok) return { ok: false, reasons: ['The object is not an event parameter of the enclosing function.'] };
    return { ok: true, reasons: ['Verify the event is cancelable and the listener is not passive.'] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const left = hit.node.left as JsNode | undefined;
    if (!left) return null;
    const obj = objectText(left, ctx);
    if (!obj || typeof hit.node.start !== 'number' || typeof hit.node.end !== 'number') return null;
    return [
      {
        start: hit.node.start,
        end: hit.node.end,
        newText: `${obj}.preventDefault()`,
        ruleId: 'WL-JS-007',
        reason: 'Chrome ignores returnValue; preventDefault() is the standard way to cancel the default action.',
      },
    ];
  },
};

function eventBindingRecipe(kind: 'attachEvent' | 'detachEvent'): Recipe {
  const isAttach = kind === 'attachEvent';
  return {
    id: isAttach ? 'RCP-ATTACHEVENT' : 'RCP-DETACHEVENT',
    name: `${kind} -> ${isAttach ? 'addEventListener' : 'removeEventListener'}`,
    version: '1.0.0',
    ruleIds: [isAttach ? 'WL-JS-001' : 'WL-JS-002'],
    level: 'CONDITIONAL',
    summary: `Renames the method and strips the "on" prefix from the event name.`,
    caveats: [
      'IE bound `this` to window inside the handler; addEventListener binds the element.',
      'Handler bodies that read window.event need the event parameter instead.',
      ...(isAttach ? [] : ['removeEventListener requires the identical function reference used for add.']),
    ],
    preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
      const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
      if (!hit || hit.node.type !== 'CallExpression') {
        return { ok: false, reasons: ['The matched call no longer exists at this position.'] };
      }
      const callee = hit.node.callee as JsNode | undefined;
      const prop = propIdent(callee);
      if (!prop || prop.name !== kind) {
        return { ok: false, reasons: [`The call is no longer .${kind}.`] };
      }
      const args = (hit.node.arguments as JsNode[]) ?? [];
      if (args.length < 2) return { ok: false, reasons: ['The call does not have an event name and a handler.'] };
      const eventArg = args[0];
      if (eventArg?.type !== 'StringLiteral') {
        return { ok: false, reasons: ['The event name is not a string literal, so the "on" prefix cannot be stripped safely.'] };
      }
      const value = String(eventArg.value ?? '');
      if (!value.startsWith('on') || value.length <= 2) {
        return { ok: false, reasons: [`The event name "${value}" does not start with "on".`] };
      }
      return { ok: true, reasons: ['Confirm the handler does not depend on `this === window`.'] };
    },
    plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
      const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
      if (!hit) return null;
      const callee = hit.node.callee as JsNode | undefined;
      const prop = propIdent(callee);
      const args = (hit.node.arguments as JsNode[]) ?? [];
      const eventArg = args[0];
      if (!prop || !eventArg) return null;
      if (typeof prop.start !== 'number' || typeof prop.end !== 'number') return null;
      if (typeof eventArg.start !== 'number' || typeof eventArg.end !== 'number') return null;
      const rawEvent = ctx.text.slice(eventArg.start, eventArg.end);
      const value = String(eventArg.value ?? '');
      const stripped = value.slice(2);
      return [
        {
          start: prop.start,
          end: prop.end,
          newText: isAttach ? 'addEventListener' : 'removeEventListener',
          ruleId: isAttach ? 'WL-JS-001' : 'WL-JS-002',
          reason: `${kind} is IE-only; the standard method is ${isAttach ? 'addEventListener' : 'removeEventListener'}.`,
        },
        {
          start: eventArg.start,
          end: eventArg.end,
          newText: quotedLike(rawEvent, stripped),
          ruleId: isAttach ? 'WL-JS-001' : 'WL-JS-002',
          reason: 'Standard listeners take the event type without the "on" prefix.',
        },
      ];
    },
  };
}

const fireEventRecipe: Recipe = {
  id: 'RCP-FIREEVENT',
  name: 'fireEvent -> dispatchEvent',
  version: '1.0.0',
  ruleIds: ['WL-DOM-001'],
  level: 'CONDITIONAL',
  summary: 'Replaces the IE event dispatch with dispatchEvent(new Event(...)) on the same element.',
  caveats: [
    'The replacement bubbles and is cancelable; the original fireEvent did not always behave that way.',
    'Any extra event payload the old code attached by hand must move to CustomEvent detail.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit || hit.node.type !== 'CallExpression') {
      return { ok: false, reasons: ['The matched call no longer exists at this position.'] };
    }
    const callee = hit.node.callee as JsNode | undefined;
    if (!callee || propIdent(callee)?.name !== 'fireEvent') {
      return { ok: false, reasons: ['The call is no longer .fireEvent.'] };
    }
    const args = (hit.node.arguments as JsNode[]) ?? [];
    if (args.length !== 1) {
      return { ok: false, reasons: ['fireEvent with a second argument carries a hand-built event object; that needs a manual rewrite.'] };
    }
    if (args[0]?.type !== 'StringLiteral') {
      return { ok: false, reasons: ['The event name is not a string literal.'] };
    }
    const name = String(args[0].value ?? '');
    if (!name.startsWith('on') || name.length <= 2) {
      return { ok: false, reasons: [`The event name "${name}" does not start with "on".`] };
    }
    return { ok: true, reasons: ['Confirm the handler chain does not depend on IE-specific event properties.'] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const callee = hit.node.callee as JsNode | undefined;
    const args = (hit.node.arguments as JsNode[]) ?? [];
    if (!callee || typeof callee.start !== 'number' || typeof callee.end !== 'number') return null;
    const target = ctx.text.slice(callee.start, callee.end);
    const element = target.replace(/\.fireEvent$/, '');
    const event = String(args[0]?.value ?? '').replace(/^on/, '');
    return [
      {
        start: hit.node.start as number,
        end: hit.node.end as number,
        newText: `${element}.dispatchEvent(new Event("${event}", { bubbles: true, cancelable: true }))`,
        ruleId: 'WL-DOM-001',
        reason: 'Chrome dispatches standard events; fireEvent does not exist.',
      },
    ];
  },
};

const execScriptRecipe: Recipe = {
  id: 'RCP-EXECSCRIPT',
  name: 'execScript -> indirect eval',
  version: '1.0.0',
  ruleIds: ['WL-JS-014'],
  level: 'CONDITIONAL',
  summary: 'Replaces window.execScript(code) with (0, eval)(code), which also evaluates in global scope.',
  caveats: [
    'A Content-Security-Policy without unsafe-eval blocks this call; check the deployment policy.',
    'Prefer removing the string evaluation entirely when the code is static.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit || hit.node.type !== 'CallExpression') {
      return { ok: false, reasons: ['The matched call no longer exists at this position.'] };
    }
    const callee = hit.node.callee as JsNode | undefined;
    if (!callee || propIdent(callee)?.name !== 'execScript') {
      return { ok: false, reasons: ['The call is no longer .execScript.'] };
    }
    const args = (hit.node.arguments as JsNode[]) ?? [];
    if (args.length !== 1) {
      return { ok: false, reasons: ['execScript with a language argument needs manual review.'] };
    }
    return { ok: true, reasons: ['Confirm the evaluated code does not rely on the IE JScript dialect.'] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const callee = hit.node.callee as JsNode | undefined;
    if (!callee || typeof callee.start !== 'number' || typeof callee.end !== 'number') return null;
    return [
      {
        start: callee.start,
        end: callee.end,
        newText: '(0, eval)',
        ruleId: 'WL-JS-014',
        reason: 'Indirect eval keeps global scope, matching execScript; a direct eval would inherit the caller scope.',
      },
    ];
  },
};

const navigateRecipe: Recipe = {
  id: 'RCP-NAVIGATE',
  name: 'window.navigate -> location.assign',
  version: '1.0.0',
  ruleIds: ['WL-JS-016'],
  level: 'CONDITIONAL',
  summary: 'Replaces the IE navigation call with location.assign on the same argument.',
  caveats: [
    'location.assign keeps the current page in the back stack; use location.replace if the old code relied on not being able to go back.',
    'Only the window-level call is rewritten; framework routers named .navigate are untouched.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit || hit.node.type !== 'CallExpression') {
      return { ok: false, reasons: ['The matched call no longer exists at this position.'] };
    }
    const callee = hit.node.callee as JsNode | undefined;
    if (!callee) return { ok: false, reasons: ['The call has no callee.'] };
    const isMember = callee.type === 'MemberExpression' && propIdent(callee)?.name === 'navigate';
    const isBare = callee.type === 'Identifier' && String(callee.name ?? '').toLowerCase() === 'navigate';
    if (!isMember && !isBare) return { ok: false, reasons: ['The call is no longer window.navigate.'] };
    if (isMember) {
      const object = (callee as JsNode).object as JsNode | undefined;
      if (!object || object.type !== 'Identifier' || String(object.name) !== 'window') {
        return { ok: false, reasons: ['An object method named .navigate is not the IE API and must not be rewritten.'] };
      }
    }
    const args = (hit.node.arguments as JsNode[]) ?? [];
    if (args.length !== 1) {
      return { ok: false, reasons: ['window.navigate with an unexpected argument count needs a manual rewrite.'] };
    }
    return { ok: true, reasons: ['Confirm whether the old page should stay in the back stack (assign vs replace).'] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const callee = hit.node.callee as JsNode | undefined;
    if (!callee || typeof callee.start !== 'number' || typeof callee.end !== 'number') return null;
    return [
      {
        start: callee.start,
        end: callee.end,
        newText: 'location.assign',
        ruleId: 'WL-JS-016',
        reason: 'window.navigate is IE-only; location.assign performs the same navigation in Chrome.',
      },
    ];
  },
};

const cssRulesRecipe: Recipe = {
  id: 'RCP-CSSRULES',
  name: 'styleSheet.rules -> cssRules',
  version: '1.0.0',
  ruleIds: ['WL-DOM-003'],
  level: 'CONDITIONAL',
  summary: 'Renames the property access on a stylesheet object.',
  caveats: [
    'Cross-origin stylesheets throw when .cssRules is read; keep the surrounding try/catch.',
    'The object is identified by name, so confirm it really is a stylesheet before applying.',
  ],
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit || hit.node.type !== 'MemberExpression') {
      return { ok: false, reasons: ['The matched member expression no longer exists at this position.'] };
    }
    const prop = propIdent(hit.node);
    if (!prop || prop.name !== 'rules') {
      return { ok: false, reasons: ['The property is no longer .rules, or it is computed access.'] };
    }
    const object = hit.node.object as JsNode | undefined;
    const objectText = object && typeof object.start === 'number' ? ctx.text.slice(object.start, object.end ?? object.start) : '';
    if (!/styleSheet|\.sheet\b|(^|\.)sheet$/i.test(objectText.trim())) {
      return { ok: false, reasons: ['The object does not look like a stylesheet; refusing to rename an unrelated property.'] };
    }
    return { ok: true, reasons: ['Confirm the stylesheet is same-origin, otherwise reading cssRules throws.'] };
  },
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null {
    const hit = findNodeByRange(ctx.parsed, finding.startOffset, finding.endOffset);
    if (!hit) return null;
    const prop = propIdent(hit.node);
    if (!prop || typeof prop.start !== 'number' || typeof prop.end !== 'number') return null;
    return [
      {
        start: prop.start,
        end: prop.end,
        newText: 'cssRules',
        ruleId: 'WL-DOM-003',
        reason: 'Chrome exposes the stylesheet rules collection as cssRules; .rules is IE-only.',
      },
    ];
  },
};

export const jsRecipes: Recipe[] = [
  srcElementRecipe,
  cancelBubbleRecipe,
  returnValueRecipe,
  eventBindingRecipe('attachEvent'),
  eventBindingRecipe('detachEvent'),
  fireEventRecipe,
  execScriptRecipe,
  navigateRecipe,
  cssRulesRecipe,
];

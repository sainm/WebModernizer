import type { JsNode } from '../parser/jsParser.js';
import { memberPath, walkJs } from '../parser/jsParser.js';
import type { JsUnit } from '../parser/index.js';
import type { FileContext } from './types.js';

export interface HandlerDefinitionFact {
  name: string;
  start: number;
  end: number;
  signatureEnd: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  snippet: string;
  windowEventStarts: number[];
  windowEventCount: number;
  paramCount: number;
  otherUses: boolean;
  container: string;
}

export interface HandlerRegistrationFact {
  name: string;
  method: string;
  eventName: string;
  line: number;
  container: string;
}

export interface MigratableHandler {
  node: JsNode;
  start: number;
  end: number;
  name: string;
  eventName: string;
  registration: string;
  container: string;
  signatureEnd: number;
  inlineCallCount: number;
  paramCount: number;
  reuseParam: string | null;
  windowEventNodes: JsNode[];
  windowEventStarts: number[];
}

function propName(node: JsNode | null | undefined): string | null {
  if (!node || node.type !== 'MemberExpression') return null;
  const prop = node.property as JsNode | undefined;
  if (!prop) return null;
  if (!node.computed && prop.type === 'Identifier') return prop.name as string;
  if (node.computed && prop.type === 'StringLiteral') return prop.value as string;
  return null;
}

function isFunctionNode(node: JsNode | null | undefined): boolean {
  return Boolean(
    node &&
      (node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ObjectMethod' ||
        node.type === 'ClassMethod'),
  );
}

function nearestFunction(ancestors: JsNode[]): JsNode | null {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (isFunctionNode(ancestors[i])) return ancestors[i];
  }
  return null;
}

function normalizeEventName(raw: string): string | null {
  let name = raw.toLowerCase();
  if (name.startsWith('on') && name.length > 2) name = name.slice(2);
  if (!name || name === 'beforeunload' || name === 'unload') return null;
  return name;
}

function inlineEventName(container: string): string | null {
  const match = /^([a-zA-Z][\w:-]*) attribute \(<[^>]+>\)$/.exec(container);
  if (!match) return null;
  return normalizeEventName(match[1]);
}

function bindingIdentifiers(pattern: JsNode | null | undefined, out: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    out.add(String(pattern.name));
    return;
  }
  if (pattern.type === 'RestElement') {
    bindingIdentifiers(pattern.argument as JsNode | undefined, out);
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    bindingIdentifiers(pattern.left as JsNode | undefined, out);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const item of (pattern.elements as JsNode[] | undefined) ?? []) bindingIdentifiers(item, out);
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const prop of (pattern.properties as JsNode[] | undefined) ?? []) {
      if (prop.type === 'ObjectProperty') bindingIdentifiers(prop.value as JsNode | undefined, out);
      else bindingIdentifiers(prop, out);
    }
  }
}

function unitBindings(unit: JsUnit): Set<string> {
  const names = new Set<string>();
  if (!unit.result.ast) return names;
  walkJs(unit.result.ast, (node) => {
    if (isFunctionNode(node)) {
      for (const param of (node.params as JsNode[] | undefined) ?? []) bindingIdentifiers(param, names);
      return;
    }
    if (node.type === 'VariableDeclarator') {
      bindingIdentifiers(node.id as JsNode | undefined, names);
      return;
    }
    if (node.type === 'CatchClause') {
      bindingIdentifiers(node.param as JsNode | undefined, names);
      return;
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      bindingIdentifiers(node.id as JsNode | undefined, names);
      return;
    }
    if (
      node.type === 'ImportSpecifier' ||
      node.type === 'ImportDefaultSpecifier' ||
      node.type === 'ImportNamespaceSpecifier'
    ) {
      bindingIdentifiers(node.local as JsNode | undefined, names);
    }
  });
  return names;
}

export interface InlineEventUnit {
  unit: JsUnit;
  eventName: string;
  refs: JsNode[];
  start: number;
  end: number;
}

function blockedWindowEventUse(node: JsNode, ancestors: JsNode[]): boolean {
  if (nearestFunction(ancestors)) return true;
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return false;
  if ((parent.type === 'AssignmentExpression' || parent.type === 'AssignmentPattern') && parent.left === node) return true;
  if (parent.type === 'UpdateExpression' && parent.argument === node) return true;
  return parent.type === 'UnaryExpression' && (parent.operator === 'delete' || parent.operator === 'typeof');
}

export function collectInlineEventUnits(ctx: Pick<FileContext, 'parsed'>): InlineEventUnit[] {
  const result: InlineEventUnit[] = [];
  for (const unit of ctx.parsed.jsUnits) {
    if (!unit.result.ast || unit.dynamic) continue;
    const eventName = inlineEventName(unit.container);
    if (!eventName) continue;
    if (unitBindings(unit).has('event')) continue;
    const refs: JsNode[] = [];
    let blocked = false;
    walkJs(unit.result.ast, (node, _parent, ancestors) => {
      if (blocked || node.type !== 'MemberExpression' || memberPath(node) !== 'window.event') return;
      if (blockedWindowEventUse(node, ancestors)) {
        blocked = true;
        return;
      }
      refs.push(node);
    });
    if (blocked || refs.length === 0) continue;
    refs.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    result.push({ unit, eventName, refs, start: unit.baseOffset, end: unit.baseOffset + unit.code.length });
  }
  return result;
}

export function findInlineEventUnitAt(ctx: Pick<FileContext, 'parsed'>, start: number): InlineEventUnit | null {
  return collectInlineEventUnits(ctx).find((item) => item.start === start) ?? null;
}

export function isInlineEventBinding(unit: JsUnit, name: string): boolean {
  if (!unit.result.ast || unit.dynamic) return false;
  if (!inlineEventName(unit.container)) return false;
  return name === 'event' && !unitBindings(unit).has('event');
}

function paramRange(ctx: Pick<FileContext, 'text'>, node: JsNode): { open: number; close: number } | null {
  const start = node.start;
  const body = node.body as JsNode | undefined;
  const bodyStart = body?.start;
  if (typeof start !== 'number' || typeof bodyStart !== 'number') return null;
  const head = ctx.text.slice(start, bodyStart);
  if (node.type === 'ArrowFunctionExpression') {
    const arrow = head.lastIndexOf('=>');
    if (arrow < 0) return null;
    const close = head.lastIndexOf(')', arrow);
    if (close < 0) return null;
    const open = head.lastIndexOf('(', close);
    if (open < 0) return null;
    return { open: start + open, close: start + close };
  }
  const open = head.indexOf('(');
  if (open < 0) return null;
  const close = head.indexOf(')', open);
  if (close < 0) return null;
  return { open: start + open, close: start + close };
}

export function handlerParamEdit(
  ctx: Pick<FileContext, 'text'>,
  node: JsNode,
): { offset: number; text: string } | null {
  const range = paramRange(ctx, node);
  if (!range) return null;
  const params = (node.params as JsNode[] | undefined) ?? [];
  if (params.length === 0) {
    if (ctx.text.slice(range.open + 1, range.close).trim() !== '') return null;
    return { offset: range.open + 1, text: 'event' };
  }
  const first = params[0];
  if (typeof first.start !== 'number') return null;
  return { offset: first.start, text: 'event, ' };
}

export function inlineCallEventEdit(
  ctx: Pick<FileContext, 'text'>,
  call: JsNode,
): { offset: number; text: string } | null {
  const args = (call.arguments as JsNode[] | undefined) ?? [];
  if (args.length > 0) {
    const first = args[0];
    if (typeof first.start !== 'number') return null;
    return { offset: first.start, text: 'event, ' };
  }
  const callee = call.callee as JsNode | undefined;
  if (!callee || callee.type !== 'Identifier') return null;
  const end = call.end;
  const calleeEnd = callee.end;
  if (typeof end !== 'number' || typeof calleeEnd !== 'number') return null;
  const tail = ctx.text.slice(calleeEnd, end);
  const open = tail.indexOf('(');
  const close = tail.indexOf(')', open);
  if (open < 0 || close < 0) return null;
  if (tail.slice(open + 1, close).trim() !== '') return null;
  return { offset: calleeEnd + open + 1, text: 'event' };
}

function scopeReadsEventIdentifier(fn: JsNode): boolean {
  let found = false;
  walkJs(fn, (node, parent, ancestors) => {
    if (found) return;
    const ownScope = node === fn || nearestFunction(ancestors) === fn;
    if (!ownScope || node.type !== 'Identifier' || node.name !== 'event') return;
    const parentNode = parent as JsNode | null;
    const memberProp = parentNode?.type === 'MemberExpression' ? (parentNode.property as JsNode | undefined) : undefined;
    const objectKey = parentNode?.type === 'ObjectProperty' ? (parentNode.key as JsNode | undefined) : undefined;
    const isProperty =
      (parentNode?.type === 'MemberExpression' && memberProp === node && !parentNode.computed) ||
      (parentNode?.type === 'ObjectProperty' &&
        objectKey === node &&
        !parentNode.computed &&
        (parentNode as Record<string, unknown>).shorthand !== true);
    if (!isProperty) found = true;
  });
  return found;
}

function scopeBindsName(fn: JsNode, name: string): boolean {
  const collect = (pattern: JsNode | null | undefined): boolean => {
    const names = new Set<string>();
    bindingIdentifiers(pattern, names);
    return names.has(name);
  };
  for (const param of (fn.params as JsNode[] | undefined) ?? []) {
    if (collect(param)) return true;
  }
  let found = false;
  walkJs(fn, (node, _parent, ancestors) => {
    if (found || nearestFunction(ancestors) !== fn) return;
    if (node.type === 'VariableDeclarator' && collect(node.id as JsNode | undefined)) found = true;
    else if (node.type === 'FunctionDeclaration' && collect(node.id as JsNode | undefined)) found = true;
    else if (node.type === 'CatchClause' && collect(node.param as JsNode | undefined)) found = true;
  });
  return found;
}

function helperSynchronousUses(fn: JsNode, helper: JsNode): { ok: boolean; calls: number } {
  const id = helper.id as JsNode | undefined;
  if (!id || id.type !== 'Identifier') return { ok: false, calls: 0 };
  const name = String(id.name);
  let ok = true;
  let calls = 0;
  walkJs(fn, (node, parent, ancestors) => {
    if (node.type !== 'Identifier' || node.name !== name || node === id) return;
    if (!(parent?.type === 'CallExpression' && parent.callee === node)) {
      ok = false;
      return;
    }
    if (nearestFunction(ancestors) !== fn) {
      ok = false;
      return;
    }
    calls += 1;
  });
  return { ok, calls };
}

interface HandlerHelper {
  node: JsNode;
  kind: 'declaration' | 'variable' | 'iife';
  name: string;
  declarationId: JsNode | null;
}

function classifyHandlerHelper(
  fn: JsNode,
  nearest: JsNode,
  outer: JsNode | null,
  parent: JsNode | null,
): HandlerHelper | null {
  if (outer !== fn) return null;
  if (nearest.type === 'FunctionDeclaration') {
    const id = nearest.id as JsNode | undefined;
    if (!id || id.type !== 'Identifier') return null;
    return { node: nearest, kind: 'declaration', name: String(id.name), declarationId: id };
  }
  if (nearest.type !== 'FunctionExpression' && nearest.type !== 'ArrowFunctionExpression') return null;
  if (parent?.type === 'VariableDeclarator') {
    const id = parent.id as JsNode | undefined;
    if (!id || id.type !== 'Identifier') return null;
    return { node: nearest, kind: 'variable', name: String(id.name), declarationId: id };
  }
  if (parent?.type === 'CallExpression' && parent.callee === nearest) {
    return { node: nearest, kind: 'iife', name: '(iife)', declarationId: null };
  }
  return null;
}

function variableSynchronousUses(
  fn: JsNode,
  name: string,
  declarationId: JsNode,
): { ok: boolean; calls: number } {
  let ok = true;
  let calls = 0;
  walkJs(fn, (node, parent, ancestors) => {
    if (node.type !== 'Identifier' || node.name !== name || node === declarationId) return;
    if (!(parent?.type === 'CallExpression' && parent.callee === node)) {
      ok = false;
      return;
    }
    if (nearestFunction(ancestors) !== fn) {
      ok = false;
      return;
    }
    calls += 1;
  });
  return { ok, calls };
}

function inspectHandlerBody(
  fn: JsNode,
  reuseParam: string | null = null,
): {
  refs: JsNode[];
  nestedRef: boolean;
  hasArguments: boolean;
  eventBinding: boolean;
} {
  const refs: JsNode[] = [];
  const helpers = new Map<JsNode, { helper: HandlerHelper; refs: JsNode[] }>();
  let nestedRef = false;
  let hasArguments = false;
  walkJs(fn, (node, _parent, ancestors) => {
    const functions = ancestors.filter(isFunctionNode);
    const nearest = functions[functions.length - 1] ?? null;
    const outer = functions[functions.length - 2] ?? null;
    const ownScope = node === fn || nearest === fn;
    if (node.type === 'MemberExpression' && memberPath(node) === 'window.event') {
      if (ownScope) refs.push(node);
      else {
        const nearestIndex = nearest ? ancestors.lastIndexOf(nearest) : -1;
        const parentOfNearest = nearestIndex > 0 ? ancestors[nearestIndex - 1] : null;
        const helper = nearest ? classifyHandlerHelper(fn, nearest, outer, parentOfNearest) : null;
        if (!helper) nestedRef = true;
        else {
          const entry = helpers.get(nearest) ?? { helper, refs: [] };
          entry.refs.push(node);
          helpers.set(nearest, entry);
        }
      }
    }
    if (ownScope && node.type === 'Identifier' && node.name === 'arguments') hasArguments = true;
  });
  for (const { helper, refs: list } of helpers.values()) {
    const uses =
      helper.kind === 'declaration'
        ? helperSynchronousUses(fn, helper.node)
        : helper.kind === 'variable' && helper.declarationId
          ? variableSynchronousUses(fn, helper.name, helper.declarationId)
          : { ok: true, calls: 1 };
    if (
      helper.node.async === true ||
      helper.node.generator === true ||
      (reuseParam ? scopeBindsName(helper.node, reuseParam) : scopeReadsEventIdentifier(helper.node)) ||
      !uses.ok ||
      uses.calls === 0
    ) {
      nestedRef = true;
      continue;
    }
    refs.push(...list);
  }
  const eventBinding = scopeReadsEventIdentifier(fn);
  return { refs, nestedRef, hasArguments, eventBinding };
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}

interface Candidate {
  node: JsNode;
  name: string;
  eventName: string;
  registration: string;
  container: string;
  headerStarts: Set<number>;
  inlineCallCount: number;
  hasReferenceRegistration: boolean;
  eventFirstRegistration: boolean;
  attachRegistration: boolean;
}

export function findMigratableHandlers(ctx: Pick<FileContext, 'parsed' | 'text'>): MigratableHandler[] {
  const declarations = new Map<string, Array<{ node: JsNode; container: string }>>();
  const calls: Array<{ node: JsNode; container: string; dynamic: boolean }> = [];
  const assignments: Array<{ node: JsNode; container: string }> = [];
  const identifierUses = new Map<string, JsNode[]>();

  for (const unit of ctx.parsed.jsUnits) {
    if (!unit.result.ast) continue;
    const container = unit.container;
    const dynamic = unit.dynamic;
    walkJs(unit.result.ast, (node, _parent, ancestors) => {
      if (node.type === 'Identifier') {
        const name = String(node.name ?? '');
        const list = identifierUses.get(name) ?? [];
        list.push(node);
        identifierUses.set(name, list);
      }
      if (node.type === 'FunctionDeclaration') {
        if (nearestFunction(ancestors)) return;
        const id = node.id as JsNode | undefined;
        if (id?.type !== 'Identifier') return;
        const name = String(id.name);
        const list = declarations.get(name) ?? [];
        list.push({ node, container });
        declarations.set(name, list);
        return;
      }
      if (node.type === 'CallExpression') calls.push({ node, container, dynamic });
      else if (node.type === 'AssignmentExpression') assignments.push({ node, container });
    });
  }

  const candidates = new Map<number, Candidate>();
  const allowedHandlerArgStarts = new Set<number>();

  const addCandidate = (
    fn: JsNode,
    name: string,
    eventName: string,
    registration: string,
    container: string,
    headerStarts: Set<number>,
    inlineCallCount = 0,
    hasReferenceRegistration = false,
    referenceKind: 'attach' | 'event-first' | null = null,
  ): void => {
    const start = fn.start ?? -1;
    if (start < 0) return;
    const existing = candidates.get(start);
    if (existing) {
      headerStarts.forEach((value) => existing.headerStarts.add(value));
      existing.inlineCallCount += inlineCallCount;
      existing.hasReferenceRegistration = existing.hasReferenceRegistration || hasReferenceRegistration;
      existing.eventFirstRegistration = existing.eventFirstRegistration || referenceKind === 'event-first';
      existing.attachRegistration = existing.attachRegistration || referenceKind === 'attach';
      return;
    }
    candidates.set(start, {
      node: fn,
      name,
      eventName,
      registration,
      container,
      headerStarts,
      inlineCallCount,
      hasReferenceRegistration,
      eventFirstRegistration: referenceKind === 'event-first',
      attachRegistration: referenceKind === 'attach',
    });
  };

  const resolveNamed = (
    node: JsNode | undefined,
  ): { fn: JsNode; name: string; container: string } | null => {
    if (!node || node.type !== 'Identifier') return null;
    const name = String(node.name ?? '');
    const list = declarations.get(name) ?? [];
    if (list.length !== 1) return null;
    return { fn: list[0].node, name, container: list[0].container };
  };

  for (const call of calls) {
    const callee = call.node.callee as JsNode | undefined;
    if (!callee || callee.type !== 'MemberExpression') continue;
    const method = propName(callee);
    if (
      method !== 'attachEvent' &&
      method !== 'detachEvent' &&
      method !== 'addEventListener' &&
      method !== 'removeEventListener'
    ) {
      continue;
    }
    const args = (call.node.arguments as JsNode[] | undefined) ?? [];
    const handlerIdentifier = args[1];
    if (handlerIdentifier?.type === 'Identifier') {
      allowedHandlerArgStarts.add(handlerIdentifier.start ?? -1);
    }
    if (method !== 'attachEvent' && method !== 'addEventListener') continue;
    if (args.length < 2 || args[0]?.type !== 'StringLiteral') continue;
    const eventName = normalizeEventName(String(args[0].value ?? ''));
    if (!eventName) continue;
    const handlerArg = args[1];
    const named = resolveNamed(handlerArg);
    if (named) {
      addCandidate(
        named.fn,
        named.name,
        eventName,
        `${method}("${String(args[0].value)}")`,
        named.container,
        new Set([handlerArg!.start ?? -1]),
        0,
        true,
        method === 'attachEvent' ? 'attach' : 'event-first',
      );
      continue;
    }
    if (handlerArg && (handlerArg.type === 'FunctionExpression' || handlerArg.type === 'ArrowFunctionExpression')) {
      addCandidate(
        handlerArg,
        '<anonymous>',
        eventName,
        `${method}("${String(args[0].value)}")`,
        call.container,
        new Set(),
        0,
        true,
        method === 'attachEvent' ? 'attach' : 'event-first',
      );
    }
  }

  for (const assignment of assignments) {
    const left = assignment.node.left as JsNode | undefined;
    const right = assignment.node.right as JsNode | undefined;
    const prop = propName(left ?? null);
    if (!prop || !prop.startsWith('on') || prop.length <= 2) continue;
    const eventName = normalizeEventName(prop);
    if (!eventName) continue;
    const named = resolveNamed(right);
    if (named) {
      addCandidate(named.fn, named.name, eventName, prop, named.container, new Set([right!.start ?? -1]), 0, true, 'event-first');
      continue;
    }
    if (right && (right.type === 'FunctionExpression' || right.type === 'ArrowFunctionExpression')) {
      addCandidate(right, '<anonymous>', eventName, prop, assignment.container, new Set(), 0, true, 'event-first');
    }
  }

  const inlineCallsByName = new Map<string, Array<{ node: JsNode; eventName: string }>>();
  for (const call of calls) {
    if (call.dynamic) continue;
    const eventName = inlineEventName(call.container);
    if (!eventName) continue;
    const callee = call.node.callee as JsNode | undefined;
    if (!callee || callee.type !== 'Identifier') continue;
    allowedHandlerArgStarts.add(callee.start ?? -1);
    const name = String(callee.name);
    const list = inlineCallsByName.get(name) ?? [];
    list.push({ node: call.node, eventName });
    inlineCallsByName.set(name, list);
  }
  for (const [name, list] of inlineCallsByName) {
    const declarationList = declarations.get(name);
    if (!declarationList || declarationList.length !== 1) continue;
    addCandidate(
      declarationList[0].node,
      name,
      list[0].eventName,
      `inline ${list[0].eventName}`,
      declarationList[0].container,
      new Set(list.map((item) => (item.node.callee as JsNode).start ?? -1)),
      list.length,
    );
  }

  const result: MigratableHandler[] = [];
  for (const candidate of candidates.values()) {
    const params = (candidate.node.params as JsNode[] | undefined) ?? [];
    const firstParam = params[0];
    const reuseParam =
      params.length > 0 &&
      candidate.eventFirstRegistration &&
      !candidate.attachRegistration &&
      candidate.inlineCallCount === 0 &&
      firstParam?.type === 'Identifier' &&
      firstParam.name !== 'event'
        ? String(firstParam.name)
        : null;
    if (params.length > 0 && candidate.hasReferenceRegistration && reuseParam === null) continue;
    const range = paramRange(ctx, candidate.node);
    if (!range) continue;
    if (handlerParamEdit(ctx, candidate.node) === null) continue;
    if (candidate.name !== '<anonymous>') {
      const declarationId = (candidate.node.id as JsNode | undefined)?.start ?? -1;
      const allowed = new Set<number>([declarationId, ...candidate.headerStarts, ...allowedHandlerArgStarts]);
      const uses = identifierUses.get(candidate.name) ?? [];
      if (uses.some((node) => !allowed.has(node.start ?? -1))) continue;
    }

    const body = inspectHandlerBody(candidate.node, reuseParam);
    if (body.refs.length === 0 || body.nestedRef || body.hasArguments || body.eventBinding) continue;
    const refs = [...body.refs].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    result.push({
      node: candidate.node,
      start: candidate.node.start ?? 0,
      end: candidate.node.end ?? 0,
      name: candidate.name,
      eventName: candidate.eventName,
      registration: candidate.registration,
      container: candidate.container,
      signatureEnd: range.close + 1,
      inlineCallCount: candidate.inlineCallCount,
      paramCount: params.length,
      reuseParam,
      windowEventNodes: refs,
      windowEventStarts: refs.map((node) => node.start ?? -1),
    });
  }
  return result;
}

export function collectHandlerFacts(ctx: Pick<FileContext, 'parsed' | 'text'>): {
  handlers: HandlerDefinitionFact[];
  registrations: HandlerRegistrationFact[];
} {
  const declarations: Array<{ node: JsNode; container: string }> = [];
  const calls: Array<{ node: JsNode; container: string; dynamic: boolean }> = [];
  const assignments: Array<{ node: JsNode; container: string }> = [];
  const identifierUses = new Map<string, JsNode[]>();
  const allowedArgStarts = new Set<number>();

  for (const unit of ctx.parsed.jsUnits) {
    if (!unit.result.ast) continue;
    const container = unit.container;
    const dynamic = unit.dynamic;
    walkJs(unit.result.ast, (node, _parent, ancestors) => {
      if (node.type === 'Identifier') {
        const name = String(node.name ?? '');
        const list = identifierUses.get(name) ?? [];
        list.push(node);
        identifierUses.set(name, list);
      }
      if (node.type === 'FunctionDeclaration') {
        if (nearestFunction(ancestors)) return;
        declarations.push({ node, container });
        return;
      }
      if (node.type === 'CallExpression') calls.push({ node, container, dynamic });
      else if (node.type === 'AssignmentExpression') assignments.push({ node, container });
    });
  }

  for (const call of calls) {
    if (call.dynamic) continue;
    if (!inlineEventName(call.container)) continue;
    const callee = call.node.callee as JsNode | undefined;
    if (callee?.type === 'Identifier') allowedArgStarts.add(callee.start ?? -1);
  }

  const registrations: HandlerRegistrationFact[] = [];
  const seen = new Set<string>();
  const addRegistration = (
    name: string,
    method: string,
    eventName: string,
    node: JsNode,
    container: string,
  ): void => {
    const line = positionOf(ctx.text, node.start ?? 0).line;
    const key = [name, method, eventName, line, container].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    registrations.push({ name, method, eventName, line, container });
  };

  for (const call of calls) {
    const callee = call.node.callee as JsNode | undefined;
    if (!callee || callee.type !== 'MemberExpression') continue;
    const method = propName(callee);
    if (
      method !== 'attachEvent' &&
      method !== 'detachEvent' &&
      method !== 'addEventListener' &&
      method !== 'removeEventListener'
    ) {
      continue;
    }
    const args = (call.node.arguments as JsNode[] | undefined) ?? [];
    const handler = args[1];
    if (handler?.type === 'Identifier') allowedArgStarts.add(handler.start ?? -1);
    if (method !== 'attachEvent' && method !== 'addEventListener') continue;
    if (args.length < 2 || args[0]?.type !== 'StringLiteral') continue;
    const eventName = normalizeEventName(String(args[0].value ?? ''));
    if (!eventName) continue;
    if (handler?.type === 'Identifier') {
      addRegistration(String(handler.name), method, eventName, call.node, call.container);
    }
  }

  for (const assignment of assignments) {
    const left = assignment.node.left as JsNode | undefined;
    const right = assignment.node.right as JsNode | undefined;
    const prop = propName(left ?? null);
    if (!prop || !prop.startsWith('on') || prop.length <= 2) continue;
    const eventName = normalizeEventName(prop);
    if (!eventName) continue;
    if (right?.type === 'Identifier') {
      allowedArgStarts.add(right.start ?? -1);
      addRegistration(String(right.name), prop, eventName, assignment.node, assignment.container);
    }
  }

  const handlers: HandlerDefinitionFact[] = [];
  for (const declaration of declarations) {
    const node = declaration.node;
    const id = node.id as JsNode | undefined;
    if (id?.type !== 'Identifier') continue;
    const name = String(id.name);
    const range = paramRange(ctx, node);
    if (!range) continue;
    if (handlerParamEdit(ctx, node) === null) continue;
    const params = (node.params as JsNode[] | undefined) ?? [];
    const body = inspectHandlerBody(node);
    if (body.refs.length === 0 || body.nestedRef || body.hasArguments || body.eventBinding) continue;
    const allowed = new Set<number>([id.start ?? -1, ...allowedArgStarts]);
    const uses = identifierUses.get(name) ?? [];
    const otherUses = uses.some((use) => !allowed.has(use.start ?? -1));
    const start = node.start ?? 0;
    const signatureEnd = range.close + 1;
    const startPosition = positionOf(ctx.text, start);
    const endPosition = positionOf(ctx.text, signatureEnd);
    handlers.push({
      name,
      start,
      end: node.end ?? start,
      signatureEnd,
      startLine: startPosition.line,
      startColumn: startPosition.column,
      endLine: endPosition.line,
      endColumn: endPosition.column,
      snippet: ctx.text.slice(start, signatureEnd).slice(0, 200),
      windowEventStarts: body.refs.map((ref) => ref.start ?? -1),
      windowEventCount: body.refs.length,
      paramCount: params.length,
      otherUses,
      container: declaration.container,
    });
  }

  return { handlers, registrations };
}

export function findHandlerAt(
  ctx: Pick<FileContext, 'parsed' | 'text'>,
  start: number,
  end: number,
): { node: JsNode; windowEventNodes: JsNode[]; signatureEnd: number } | null {
  let result: { node: JsNode; windowEventNodes: JsNode[]; signatureEnd: number } | null = null;
  for (const unit of ctx.parsed.jsUnits) {
    if (!unit.result.ast) continue;
    walkJs(unit.result.ast, (node) => {
      if (result) return;
      if (!isFunctionNode(node) || node.start !== start || node.end !== end) return;
      const range = paramRange(ctx, node);
      if (!range) return;
      if (handlerParamEdit(ctx, node) === null) return;
      const body = inspectHandlerBody(node);
      if (body.refs.length === 0 || body.nestedRef || body.hasArguments || body.eventBinding) return;
      result = { node, windowEventNodes: body.refs, signatureEnd: range.close + 1 };
    });
  }
  return result;
}

export interface InlineHandlerCallFact {
  name: string;
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  eventName: string;
  container: string;
  argumentCount: number;
  snippet: string;
}

export function collectInlineHandlerCalls(ctx: Pick<FileContext, 'parsed' | 'text'>): {
  calls: InlineHandlerCallFact[];
  directCalls: string[];
} {
  const calls: InlineHandlerCallFact[] = [];
  const direct = new Set<string>();
  for (const unit of ctx.parsed.jsUnits) {
    if (!unit.result.ast) continue;
    const eventName = unit.dynamic ? null : inlineEventName(unit.container);
    walkJs(unit.result.ast, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || callee.type !== 'Identifier') return;
      const name = String(callee.name ?? '');
      if (!name) return;
      const args = (node.arguments as JsNode[] | undefined) ?? [];
      if (eventName) {
        const start = node.start ?? 0;
        const end = node.end ?? start;
        const startPosition = positionOf(ctx.text, start);
        const endPosition = positionOf(ctx.text, end);
        calls.push({
          name,
          start,
          end,
          startLine: startPosition.line,
          startColumn: startPosition.column,
          endLine: endPosition.line,
          endColumn: endPosition.column,
          eventName,
          container: unit.container,
          argumentCount: args.length,
          snippet: ctx.text.slice(start, end).slice(0, 200),
        });
        return;
      }
      direct.add(name);
    });
  }
  return { calls, directCalls: [...direct] };
}

export function findInlineHandlerCalls(
  ctx: Pick<FileContext, 'parsed'>,
  handlerName: string,
): Array<{ node: JsNode; eventName: string }> {
  const calls: Array<{ node: JsNode; eventName: string }> = [];
  for (const unit of ctx.parsed.jsUnits) {
    if (!unit.result.ast || unit.dynamic) continue;
    const eventName = inlineEventName(unit.container);
    if (!eventName) continue;
    walkJs(unit.result.ast, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as JsNode | undefined;
      if (!callee || callee.type !== 'Identifier' || String(callee.name) !== handlerName) return;
      calls.push({ node, eventName });
    });
  }
  return calls;
}

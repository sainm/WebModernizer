import { parse as babelParse, type ParserPlugin } from '@babel/parser';

export interface JsNode {
  type: string;
  start: number | null;
  end: number | null;
  [key: string]: unknown;
}

export interface JsParseError {
  message: string;
  /** Absolute offset inside the whole file */
  offset: number;
  recovered: boolean;
}

export interface JsParseResult {
  ast: JsNode | null;
  errors: JsParseError[];
  /** Fragment base offset, used to map node.start to a file-absolute position */
  baseOffset: number;
  /** Whether a traversable AST was produced */
  ok: boolean;
  /** Whether script or module semantics won the parse */
  sourceType: 'script' | 'module';
}

const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'type',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'errors',
  'tokens',
  'parenthesized',
]);

function buildOptions(sourceType: 'script' | 'module', plugins: ParserPlugin[]) {
  return {
    sourceType,
    // Offsets are kept, and positions are normalized by LineIndex; Babel's startLine is never used.
    ranges: true,
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowUndeclaredExports: true,
    allowNewTargetOutsideFunction: true,
    attachComment: false,
    plugins,
    // Legacy code relies on permissive parsing (trailing commas, legacy literals).
    createParenthesizedExpressions: false,
  };
}

/**
 * Shifts every node offset by baseOffset so that all downstream consumers can treat
 * node.start / node.end as file-absolute. Doing it once here is far safer than
 * remembering to add the offset in each rule and recipe.
 */
function shiftOffsets(node: JsNode | null | undefined, baseOffset: number): void {
  if (!node || baseOffset === 0) return;
  if (typeof node.start === 'number') node.start += baseOffset;
  if (typeof node.end === 'number') node.end += baseOffset;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof (item as JsNode).type === 'string') shiftOffsets(item as JsNode, baseOffset);
      }
    } else if (value && typeof (value as JsNode).type === 'string') {
      shiftOffsets(value as JsNode, baseOffset);
    }
  }
}

/**
 * Parses a JavaScript fragment: a standalone .js file, a <script> block inside
 * HTML/JSP, or an inline handler attribute.
 *
 * Babel's startLine / startIndex are deliberately not used. The fragment is parsed
 * on its own, node.start stays fragment-relative, and baseOffset is added back
 * explicitly. This keeps offset semantics deterministic across Babel versions.
 */
export function parseJavaScriptFragment(
  code: string,
  baseOffset = 0,
  preferredSourceType: 'script' | 'module' = 'script',
): JsParseResult {
  const attempts: Array<{ sourceType: 'script' | 'module'; plugins: ParserPlugin[] }> = [
    { sourceType: preferredSourceType, plugins: [] },
    { sourceType: 'script', plugins: [] },
    { sourceType: 'module', plugins: [] },
    { sourceType: 'script', plugins: ['jsx'] },
    { sourceType: 'module', plugins: ['jsx'] },
  ];

  let firstErrors: JsParseError[] = [];
  let best: { ast: JsNode; sourceType: 'script' | 'module'; errors: JsParseError[] } | null = null;

  for (const attempt of attempts) {
    try {
      const ast = babelParse(code, buildOptions(attempt.sourceType, attempt.plugins)) as unknown as JsNode & {
        errors?: Array<{ message: string; pos?: number; loc?: { line: number; column: number } }>;
      };
      shiftOffsets(ast, baseOffset);
      const recovered = (ast.errors ?? []).map((err) => ({
        message: err.message,
        offset: baseOffset + (typeof err.pos === 'number' ? err.pos : 0),
        recovered: true,
      }));
      if (!best) {
        best = { ast, sourceType: attempt.sourceType, errors: recovered };
      }
      if (recovered.length === 0) {
        return { ast, errors: [], baseOffset, ok: true, sourceType: attempt.sourceType };
      }
      if (!firstErrors.length) firstErrors = recovered;
    } catch (err) {
      const e = err as { message: string; pos?: number };
      const item: JsParseError = {
        message: e.message,
        offset: baseOffset + (typeof e.pos === 'number' ? e.pos : 0),
        recovered: false,
      };
      if (!firstErrors.length) firstErrors = [item];
      // Try the remaining modes: module, then jsx, before giving up
    }
  }

  if (best) {
    return {
      ast: best.ast,
      errors: best.errors.length ? best.errors : firstErrors,
      baseOffset,
      ok: best.errors.length === 0,
      sourceType: best.sourceType,
    };
  }

  return { ast: null, errors: firstErrors, baseOffset, ok: false, sourceType: preferredSourceType };
}

/** Depth-first AST traversal carrying the parent chain. */
export function walkJs(
  node: JsNode | null | undefined,
  visitor: (node: JsNode, parent: JsNode | null, ancestors: JsNode[]) => void,
  parent: JsNode | null = null,
  ancestors: JsNode[] = [],
): void {
  if (!node || typeof node.type !== 'string') return;
  visitor(node, parent, ancestors);
  const nextAncestors = parent ? [...ancestors, node] : [node];
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof (item as JsNode).type === 'string') {
          walkJs(item as JsNode, visitor, node, nextAncestors);
        }
      }
    } else if (value && typeof (value as JsNode).type === 'string') {
      walkJs(value as JsNode, visitor, node, nextAncestors);
    }
  }
}

/**
 * Renders a member expression as a dotted path.
 *  - `window.event`      -> "window.event"
 *  - `e.srcElement`      -> "*.srcElement" (wildcard for arbitrary objects)
 *  - `document["all"]`   -> "document.all"
 * Returns null when the path cannot be determined statically.
 */
export function memberPath(node: JsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name as string;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type !== 'MemberExpression') return null;
  const objectPath = memberPath(node.object as JsNode);
  if (node.computed) {
    const prop = node.property as JsNode;
    if (prop?.type === 'StringLiteral') {
      return objectPath ? `${objectPath}.${prop.value as string}` : String(prop.value);
    }
    return null;
  }
  const property = node.property as JsNode;
  if (property?.type !== 'Identifier') return null;
  // Only keep known globals by name; otherwise wildcard so obj.event is not read as window.event
  if (objectPath === 'window' || objectPath === 'document' || objectPath === 'self' || objectPath === 'top') {
    return `${objectPath}.${property.name as string}`;
  }
  return `*.${property.name as string}`;
}

/** Whether the member object is exactly the given global (no wildcard) */
export function isGlobalMember(node: JsNode, globalName: string, propName: string): boolean {
  if (node.type !== 'MemberExpression') return false;
  const obj = node.object as JsNode;
  const prop = node.property as JsNode;
  if (!obj || obj.type !== 'Identifier' || obj.name !== globalName) return false;
  if (node.computed) {
    return prop?.type === 'StringLiteral' && prop.value === propName;
  }
  return prop?.type === 'Identifier' && prop.name === propName;
}

/** Finds the enclosing function that declares the identifier as a parameter */
export function findEnclosingParam(name: string, ancestors: JsNode[]): JsNode | null {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const node = ancestors[i];
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassMethod'
    ) {
      for (const param of (node.params as JsNode[]) ?? []) {
        if (param.type === 'Identifier' && param.name === name) return node;
      }
    }
  }
  return null;
}

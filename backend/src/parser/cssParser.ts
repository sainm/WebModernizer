import postcss, { type Root } from 'postcss';

export interface CssDeclaration {
  prop: string;
  value: string;
  important: boolean;
  /** File-absolute offset of the declaration start (includes the property) */
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  /** Full raw declaration, e.g. "width: expression(...)" */
  raw: string;
  /** Enclosing rule selector, used as context */
  selector: string | null;
  /** Chain of enclosing at-rules such as @media / @supports */
  atRuleChain: string[];
}

export interface CssRuleInfo {
  selector: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  atRuleChain: string[];
}

export interface CssAtRuleInfo {
  name: string;
  params: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
}

export interface CssParseResult {
  root: Root | null;
  declarations: CssDeclaration[];
  rules: CssRuleInfo[];
  atRules: CssAtRuleInfo[];
  errors: Array<{ message: string; offset: number }>;
  baseOffset: number;
}

function atRuleChainOf(node: { parent?: unknown }): string[] {
  const chain: string[] = [];
  let cur = node.parent as { type?: string; name?: string; params?: string; parent?: unknown } | undefined;
  while (cur && cur.type) {
    if (cur.type === 'atrule' && cur.name) chain.unshift(`@${cur.name} ${cur.params ?? ''}`.trim());
    cur = cur.parent as typeof cur;
  }
  return chain;
}

function selectorOf(node: { parent?: unknown }): string | null {
  const parent = node.parent as { type?: string; selector?: string } | undefined;
  if (parent?.type === 'rule' && typeof parent.selector === 'string') return parent.selector;
  return null;
}

/**
 * Parses a CSS fragment. baseOffset matters for inline <style> blocks: PostCSS
 * reports offsets relative to the input string, and adding baseOffset turns them
 * into file-absolute positions. Line math stays with LineIndex.
 */
export function parseCssFragment(code: string, baseOffset = 0, fileName = 'inline.css'): CssParseResult {
  const errors: Array<{ message: string; offset: number }> = [];
  const declarations: CssDeclaration[] = [];
  const rules: CssRuleInfo[] = [];
  const atRules: CssAtRuleInfo[] = [];

  let root: Root | null = null;
  try {
    root = postcss.parse(code, { from: fileName });
  } catch (err) {
    const e = err as { message: string; line?: number; column?: number };
    // On syntax errors, degrade gracefully instead of dropping the whole file
    errors.push({ message: e.message, offset: baseOffset });
    return { root: null, declarations, rules, atRules, errors, baseOffset };
  }

  root.walkDecls((decl) => {
    const start = decl.source?.start;
    const end = decl.source?.end;
    if (!start || !end || typeof start.offset !== 'number' || typeof end.offset !== 'number') return;
    const absStart = baseOffset + start.offset;
    const absEnd = baseOffset + end.offset;
    declarations.push({
      prop: decl.prop,
      value: decl.value,
      important: Boolean(decl.important),
      startOffset: absStart,
      endOffset: absEnd,
      startLine: start.line,
      startColumn: start.column,
      raw: code.slice(start.offset, end.offset),
      selector: selectorOf(decl),
      atRuleChain: atRuleChainOf(decl),
    });
  });

  root.walkRules((rule) => {
    const start = rule.source?.start;
    const end = rule.source?.end;
    if (!start || !end || typeof start.offset !== 'number' || typeof end.offset !== 'number') return;
    rules.push({
      selector: rule.selector,
      startOffset: baseOffset + start.offset,
      endOffset: baseOffset + end.offset,
      startLine: start.line,
      startColumn: start.column,
      atRuleChain: atRuleChainOf(rule),
    });
  });

  root.walkAtRules((atRule) => {
    const start = atRule.source?.start;
    const end = atRule.source?.end;
    if (!start || !end || typeof start.offset !== 'number' || typeof end.offset !== 'number') return;
    atRules.push({
      name: atRule.name,
      params: atRule.params,
      startOffset: baseOffset + start.offset,
      endOffset: baseOffset + end.offset,
      startLine: start.line,
      startColumn: start.column,
    });
  });

  return { root, declarations, rules, atRules, errors, baseOffset };
}

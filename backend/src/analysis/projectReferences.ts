import { dirname, posix } from 'node:path';
import type { FileReference, RelationConfidence } from '../model/types.js';
import type { ParsedFile } from '../parser/index.js';
import { rawAttributeValue } from '../parser/htmlParser.js';
import { walkJs, type JsNode } from '../parser/jsParser.js';

export interface ImportHint {
  raw: string;
  kind: 'SCRIPT_SRC' | 'STYLESHEET' | 'JS_IMPORT';
  line: number;
  dynamic: boolean;
}

/**
 * Per-file facts kept after parsing. The full AST is discarded once a file is
 * analyzed, so a scan of a large project does not have to hold every tree in memory.
 */
export interface FileRefFacts {
  path: string;
  imports: ImportHint[];
  /** Global function names this file provides */
  defines: string[];
  /** Function names this file invokes */
  calls: string[];
}

const MAX_RELATIONS = 20000;

function stripSuffix(raw: string): string {
  const hash = raw.indexOf('#');
  const query = raw.indexOf('?');
  let end = raw.length;
  if (hash >= 0) end = Math.min(end, hash);
  if (query >= 0) end = Math.min(end, query);
  return raw.slice(0, end).trim();
}

function isExternal(raw: string): boolean {
  return /^(https?:)?\/\//i.test(raw) || /^(data|mailto|javascript|about|blob):/i.test(raw);
}

function isDynamic(raw: string): boolean {
  return /<%|\$\{|#\{/.test(raw);
}

function normalizeTarget(fromPath: string, raw: string): string | null {
  const cleaned = stripSuffix(raw);
  if (!cleaned) return null;
  let candidate: string;
  if (cleaned.startsWith('/')) {
    candidate = posix.normalize(cleaned.replace(/^\/+/, ''));
  } else {
    const dir = dirname(fromPath);
    candidate = posix.normalize(dir === '.' ? cleaned : posix.join(dir, cleaned));
  }
  if (candidate.startsWith('..')) return null;
  return candidate;
}

function resolveExisting(candidate: string, allPaths: Set<string>): string | null {
  if (allPaths.has(candidate)) return candidate;
  const extensions = ['.js', '.jsp', '.html', '.htm', '.css'];
  for (const ext of extensions) {
    if (allPaths.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
  }
  if (allPaths.has(`${candidate}/index.jsp`)) return `${candidate}/index.jsp`;
  return null;
}

export function extractRefFacts(parsed: ParsedFile): FileRefFacts {
  const facts: FileRefFacts = { path: parsed.file.path, imports: [], defines: [], calls: [] };

  const html = parsed.html;
  if (html) {
    for (const element of html.elements) {
      const tag = (element.tagName ?? '').toLowerCase();
      if (tag === 'script') {
        const src = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'src');
        if (!src) continue;
        const raw = rawAttributeValue(element, 'src', parsed.file.content);
        const value = raw?.value ?? src.value;
        facts.imports.push({
          raw: value,
          kind: 'SCRIPT_SRC',
          line: element.sourceCodeLocation?.startLine ?? 0,
          dynamic: isDynamic(value),
        });
      } else if (tag === 'link') {
        const rel = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'rel');
        if (!rel || !/stylesheet/i.test(rel.value)) continue;
        const href = (element.attrs ?? []).find((a) => a.name.toLowerCase() === 'href');
        if (!href) continue;
        const raw = rawAttributeValue(element, 'href', parsed.file.content);
        const value = raw?.value ?? href.value;
        facts.imports.push({
          raw: value,
          kind: 'STYLESHEET',
          line: element.sourceCodeLocation?.startLine ?? 0,
          dynamic: isDynamic(value),
        });
      }
    }
  }

  for (const unit of parsed.jsUnits) {
    if (!unit.result.ast) continue;
    walkJs(unit.result.ast, (node) => {
      if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        const source = node.source as JsNode | undefined;
        if (source?.type === 'StringLiteral') {
          facts.imports.push({
            raw: String(source.value ?? ''),
            kind: 'JS_IMPORT',
            line: unit.startLine,
            dynamic: false,
          });
        }
        return;
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee as JsNode | undefined;
        if (callee?.type === 'Identifier' && callee.name === 'require') {
          const first = ((node.arguments as JsNode[]) ?? [])[0];
          if (first?.type === 'StringLiteral') {
            facts.imports.push({ raw: String(first.value ?? ''), kind: 'JS_IMPORT', line: unit.startLine, dynamic: false });
          }
        }
        if (callee?.type === 'Identifier') {
          const name = String(callee.name);
          if (name.length > 1) facts.calls.push(name);
        }
        return;
      }
      if (node.type === 'FunctionDeclaration') {
        const id = node.id as JsNode | undefined;
        if (id?.type === 'Identifier') facts.defines.push(String(id.name));
        return;
      }
      if (node.type === 'VariableDeclarator') {
        const id = node.id as JsNode | undefined;
        const init = node.init as JsNode | undefined;
        if (
          id?.type === 'Identifier' &&
          (init?.type === 'FunctionExpression' || init?.type === 'ArrowFunctionExpression')
        ) {
          facts.defines.push(String(id.name));
        }
        return;
      }
      if (node.type === 'AssignmentExpression') {
        const left = node.left as JsNode | undefined;
        const right = node.right as JsNode | undefined;
        if (!left || left.type !== 'MemberExpression') return;
        const obj = left.object as JsNode | undefined;
        const prop = left.property as JsNode | undefined;
        const isWindow = obj?.type === 'Identifier' && obj.name === 'window';
        const isFunctionValue = right?.type === 'FunctionExpression' || right?.type === 'ArrowFunctionExpression';
        if (isWindow && prop?.type === 'Identifier' && isFunctionValue) {
          facts.defines.push(String(prop.name));
        }
      }
    });
  }

  // Keep only names that are plausible globals; local helpers would create noisy edges.
  facts.defines = [...new Set(facts.defines)];
  facts.calls = [...new Set(facts.calls)];
  return facts;
}

export interface ReferenceAnalysisResult {
  relations: FileReference[];
  warnings: string[];
  /** Dynamic import targets that could not be resolved */
  unresolved: Array<{ from: string; raw: string; line: number; reason: string }>;
}

export function buildRelations(facts: FileRefFacts[], allPaths: Set<string>): ReferenceAnalysisResult {
  const relations: FileReference[] = [];
  const warnings: string[] = [];
  const unresolved: ReferenceAnalysisResult['unresolved'] = [];
  const seen = new Set<string>();

  const push = (rel: FileReference): void => {
    if (relations.length >= MAX_RELATIONS) return;
    const key = `${rel.fromPath}|${rel.toPath}|${rel.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    relations.push(rel);
  };

  for (const fact of facts) {
    for (const hint of fact.imports) {
      if (isExternal(hint.raw)) continue;

      if (hint.dynamic) {
        // Keep only the literal part that follows the last server-side token, e.g.
        // "<%=ctx%>/js/common.js" -> "/js/common.js". Anything before it is unknown.
        const tailMatch = /(?:%>|\})([^%$#]*)$/.exec(hint.raw);
        const tail = tailMatch?.[1]?.trim() ?? '';
        unresolved.push({
          from: fact.path,
          raw: hint.raw,
          line: hint.line,
          reason: 'Server-side expression in the URL; the runtime target cannot be resolved statically.',
        });
        if (tail) {
          const guess = normalizeTarget(fact.path, tail);
          const resolved = guess ? resolveExisting(guess, allPaths) : null;
          if (resolved) {
            push({
              fromPath: fact.path,
              toPath: resolved,
              kind: hint.kind,
              confidence: 'UNKNOWN',
              evidence: `Generated URL; the static suffix points at ${resolved}, but the runtime prefix depends on server state.`,
              line: hint.line,
            });
          }
        }
        continue;
      }

      const target = normalizeTarget(fact.path, hint.raw);
      if (!target) {
        warnings.push(`${fact.path}:${hint.line} cannot normalize reference "${hint.raw}"`);
        continue;
      }
      const resolved = resolveExisting(target, allPaths);
      if (!resolved) {
        unresolved.push({
          from: fact.path,
          raw: hint.raw,
          line: hint.line,
          reason: `No file in the project matches "${target}".`,
        });
        continue;
      }
      push({
        fromPath: fact.path,
        toPath: resolved,
        kind: hint.kind,
        confidence: 'CONFIRMED',
        evidence: `${hint.kind} reference "${hint.raw}" resolved to ${resolved}.`,
        line: hint.line,
      });
    }
  }

  // Shared-function edges: a call in file A resolving to a definition only in file B.
  const definitions = new Map<string, string[]>();
  for (const fact of facts) {
    for (const name of fact.defines) {
      const list = definitions.get(name) ?? [];
      if (!list.includes(fact.path)) list.push(fact.path);
      definitions.set(name, list);
    }
  }

  for (const fact of facts) {
    for (const name of fact.calls) {
      const owners = definitions.get(name);
      if (!owners || owners.length === 0) continue;
      if (owners.includes(fact.path)) continue;
      if (owners.length > 1) {
        // Ambiguous global: record it, but never pretend it is a confirmed edge.
        for (const owner of owners) {
          push({
            fromPath: fact.path,
            toPath: owner,
            kind: 'SHARED_FUNCTION_CALL',
            confidence: 'UNKNOWN',
            evidence: `"${name}" is defined in ${owners.length} files, so this call cannot be attributed.`,
          });
        }
        continue;
      }
      push({
        fromPath: fact.path,
        toPath: owners[0],
        kind: 'SHARED_FUNCTION_CALL',
        confidence: 'INFERRED',
        evidence: `Calls "${name}", which is defined only in ${owners[0]}.`,
      });
    }
  }

  return { relations, warnings, unresolved };
}

export function confidenceRank(confidence: RelationConfidence): number {
  return confidence === 'CONFIRMED' ? 0 : confidence === 'INFERRED' ? 1 : 2;
}

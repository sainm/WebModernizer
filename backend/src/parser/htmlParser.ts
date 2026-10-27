import { parse as parse5Parse } from 'parse5';

/**
 * parse5 sourceCodeLocation:
 *   startLine/endLine and startCol/endCol are 1-based, offsets are 0-based.
 * We adopt the same convention here, matching LineIndex.positionAt.
 */
export interface P5Location {
  startLine: number;
  startCol: number;
  startOffset: number;
  endLine: number;
  endCol: number;
  endOffset: number;
  startTag?: P5Location;
  endTag?: P5Location;
  attrs?: Record<string, P5Location>;
}

export interface P5Attribute {
  name: string;
  value: string;
  sourceCodeLocation?: P5Location;
}

export interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  data?: string;
  attrs?: P5Attribute[];
  childNodes?: P5Node[];
  sourceCodeLocation?: P5Location;
  namespaceURI?: string;
  parentNode?: P5Node;
}

export interface HtmlDoc {
  document: P5Node;
  elements: P5Node[];
  comments: P5Node[];
  /** Parser diagnostics collected through onParseError */
  errors: Array<{ message: string; line?: number; column?: number }>;
}

const RAWTEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext']);

export function parseHtml(text: string): HtmlDoc {
  const errors: Array<{ message: string; line?: number; column?: number }> = [];
  let document: P5Node;
  try {
    document = parse5Parse(text, {
      sourceCodeLocationInfo: true,
      onParseError: (err) => {
        errors.push({
          message: err.code ?? 'parse error',
          line: (err as unknown as { startLine?: number }).startLine,
          column: (err as unknown as { startCol?: number }).startCol,
        });
      },
    }) as unknown as P5Node;
  } catch (err) {
    return {
      document: { nodeName: '#document', childNodes: [] },
      elements: [],
      comments: [],
      errors: [{ message: (err as Error).message }],
    };
  }

  const elements: P5Node[] = [];
  const comments: P5Node[] = [];

  const visit = (node: P5Node, parent: P5Node | null): void => {
    node.parentNode = parent ?? undefined;
    if (node.tagName) elements.push(node);
    if (node.nodeName === '#comment') comments.push(node);
    for (const child of node.childNodes ?? []) visit(child, node);
  };
  visit(document, null);

  return { document, elements, comments, errors };
}

export function elementText(element: P5Node): string {
  let out = '';
  for (const child of element.childNodes ?? []) {
    if (child.nodeName === '#text') out += child.value ?? '';
    else if (RAWTEXT_TAGS.has(child.tagName ?? '')) out += elementText(child);
    else out += elementText(child);
  }
  return out;
}

export function getAttr(element: P5Node, name: string): P5Attribute | undefined {
  return (element.attrs ?? []).find((attr) => attr.name.toLowerCase() === name);
}

export function locationOf(node: P5Node): P5Location | undefined {
  return node.sourceCodeLocation;
}

/**
 * parse5 v7 does not attach a location to the attribute object itself; it exposes
 * `element.sourceCodeLocation.attrs[attrName]` instead. Lookup is case-insensitive
 * because the map keys keep the casing used in the source.
 */
export function attributeLocation(element: P5Node, attrName: string): P5Location | undefined {
  const map = element.sourceCodeLocation?.attrs;
  if (!map) return undefined;
  const direct = map[attrName];
  if (direct) return direct;
  const lower = attrName.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) return map[key];
  }
  return undefined;
}

/**
 * Absolute offset of an attribute value.
 * The attribute location spans the whole `onclick = "go()"` segment, so we skip
 * `=`, whitespace and the opening quote. Falls back to the attribute start when
 * the source is malformed.
 */
export function attributeValueOffset(loc: P5Location, text: string): number {
  if (!loc) return -1;
  const segment = text.slice(loc.startOffset, loc.endOffset);
  const eq = segment.indexOf('=');
  if (eq < 0) return loc.startOffset + segment.length;
  let i = eq + 1;
  while (i < segment.length && /\s/.test(segment[i])) i += 1;
  if (segment[i] === '"' || segment[i] === "'") i += 1;
  return loc.startOffset + i;
}

/** Raw (entity-undecoded) attribute text so offsets keep matching the source */
export function rawAttributeValue(
  element: P5Node,
  attrName: string,
  text: string,
): { value: string; offset: number } | null {
  const loc = attributeLocation(element, attrName);
  if (!loc) return null;
  const valueOffset = attributeValueOffset(loc, text);
  if (valueOffset < 0) return null;
  const quote = text[valueOffset - 1];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, valueOffset);
    return { value: text.slice(valueOffset, close < 0 ? text.length : close), offset: valueOffset };
  }
  let end = valueOffset;
  while (end < text.length && !/[\s>]/.test(text[end])) end += 1;
  return { value: text.slice(valueOffset, end), offset: valueOffset };
}

export function isConditionalComment(data: string): boolean {
  return /\[if\s+[^\]]*IE[^\]]*\]/i.test(data) || /\[if\s*!\s*IE\]/i.test(data) || /\[endif\]/i.test(data);
}

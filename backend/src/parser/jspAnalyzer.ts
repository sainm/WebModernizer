/**
 * Layered JSP analysis.
 *
 * Hard constraint: a JSP file is not HTML. Feeding .jsp straight to an HTML parser
 * treats Java code inside `<% ... %>` as text and lets tags such as `<logic:iterate>`
 * corrupt the tree, which destroys every offset and line number we report.
 *
 * Strategy: equal-length masking.
 *   1. Overwrite server-side dynamic regions (scriptlet / expression / declaration /
 *      directive / EL / jsp: tags) with spaces, but keep \n and \r so that the
 *      masked text has exactly the same length and line breaks as the original.
 *   2. Hand the masked text to the HTML parser; every offset it returns is directly
 *      valid for the original file.
 *   3. Parse static fragments (<script>, <style>, onclick, ...) separately and record
 *      their baseOffset so findings still point into the original .jsp file.
 *   4. Fragments intersecting a dynamic region are marked dynamic, downgraded to
 *      NEEDS_ANALYSIS confidence, and never auto-converted.
 */

export type DynamicRegionKind =
  | 'COMMENT'
  | 'DIRECTIVE'
  | 'DECLARATION'
  | 'EXPRESSION'
  | 'SCRIPTLET'
  | 'EL'
  | 'JSP_TAG';

export interface DynamicRegion {
  start: number;
  end: number;
  kind: DynamicRegionKind;
  text: string;
}

export interface JspAnalysis {
  masked: string;
  regions: DynamicRegion[];
  hasDynamic: boolean;
}

function blankOut(source: string, from: number, to: number): string {
  // Keep newlines, blank out everything else, preserve length
  return source.slice(from, to).replace(/[^\n\r]/g, ' ');
}

export function analyzeJsp(source: string): JspAnalysis {
  const regions: DynamicRegion[] = [];
  const chars = source.split('');
  const maskRange = (start: number, end: number, kind: DynamicRegionKind): void => {
    const blanked = blankOut(source, start, end);
    for (let i = 0; i < blanked.length; i += 1) chars[start + i] = blanked[i];
    regions.push({ start, end, kind, text: source.slice(start, end) });
  };

  let i = 0;
  while (i < source.length) {
    // JSP comments first: their body may contain sequences other than %>
    if (source.startsWith('<%--', i)) {
      const close = source.indexOf('--%>', i + 4);
      const end = close < 0 ? source.length : close + 4;
      maskRange(i, end, 'COMMENT');
      i = end;
      continue;
    }
    if (source.startsWith('<%@', i)) {
      const close = source.indexOf('%>', i + 3);
      const end = close < 0 ? source.length : close + 2;
      maskRange(i, end, 'DIRECTIVE');
      i = end;
      continue;
    }
    if (source.startsWith('<%!', i)) {
      const close = source.indexOf('%>', i + 3);
      const end = close < 0 ? source.length : close + 2;
      maskRange(i, end, 'DECLARATION');
      i = end;
      continue;
    }
    if (source.startsWith('<%=', i)) {
      const close = source.indexOf('%>', i + 3);
      const end = close < 0 ? source.length : close + 2;
      maskRange(i, end, 'EXPRESSION');
      i = end;
      continue;
    }
    if (source.startsWith('<%', i)) {
      const close = source.indexOf('%>', i + 2);
      const end = close < 0 ? source.length : close + 2;
      maskRange(i, end, 'SCRIPTLET');
      i = end;
      continue;
    }
    // EL expressions ${...} / #{...}, with simple nesting support
    if ((source[i] === '$' || source[i] === '#') && source[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      let end = -1;
      while (j < source.length) {
        if (source[j] === '{') depth += 1;
        else if (source[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = j + 1;
            break;
          }
        }
        j += 1;
      }
      if (end > 0) {
        maskRange(i, end, 'EL');
        i = end;
        continue;
      }
    }
    // <jsp:xxx ...> / </jsp:xxx>
    if (source.startsWith('<jsp:', i) || source.startsWith('</jsp:', i)) {
      const close = source.indexOf('>', i);
      const end = close < 0 ? source.length : close + 1;
      maskRange(i, end, 'JSP_TAG');
      i = end;
      continue;
    }
    i += 1;
  }

  return { masked: chars.join(''), regions, hasDynamic: regions.length > 0 };
}

/** Returns true when [start, end) intersects any dynamic region */
export function intersectsRegions(regions: DynamicRegion[], start: number, end: number): DynamicRegion | null {
  for (const region of regions) {
    if (start < region.end && end > region.start) return region;
  }
  return null;
}

/** Renders a dynamic region as a readable description for evidence display */
export function describeRegion(region: DynamicRegion): string {
  const map: Record<DynamicRegionKind, string> = {
    COMMENT: 'JSP comment',
    DIRECTIVE: 'JSP directive',
    DECLARATION: 'JSP declaration',
    EXPRESSION: 'JSP expression',
    SCRIPTLET: 'JSP scriptlet',
    EL: 'EL expression',
    JSP_TAG: 'jsp standard tag',
  };
  const oneLine = region.text.replace(/\s+/g, ' ').slice(0, 80);
  return `${map[region.kind]}: ${oneLine}`;
}

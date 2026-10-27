import { analyzeParsedFile } from '../src/analysis/engine.js';
import { makeSourceFile, parseSourceFile } from '../src/parser/index.js';
import { RECIPE_RULE_IDS } from '../src/recipes/registry.js';
import type { AnalysisFinding } from '../src/model/types.js';

export interface AnalyzeResult {
  findings: AnalysisFinding[];
  parsed: ReturnType<typeof parseSourceFile>;
}

export function analyzeText(relPath: string, content: string): AnalyzeResult {
  const parsed = parseSourceFile(makeSourceFile('/project', relPath, `/project/${relPath}`, content));
  const findings = analyzeParsedFile(parsed, { scanTaskId: 'test-scan', recipeRuleIds: RECIPE_RULE_IDS });
  return { findings, parsed };
}

export function byRule(findings: AnalysisFinding[], ruleId: string): AnalysisFinding[] {
  return findings.filter((finding) => finding.ruleId === ruleId);
}

/** Line/column of a marker inside a fixture, so assertions never hardcode offsets. */
export function positionOf(content: string, marker: string, occurrence = 1): { line: number; column: number } {
  let index = -1;
  for (let i = 0; i < occurrence; i += 1) {
    index = content.indexOf(marker, index + 1);
    if (index < 0) throw new Error(`marker not found: ${marker}`);
  }
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  const column = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}

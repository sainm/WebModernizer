import { newId, nowIso } from '../model/ids.js';
import type { AnalysisFinding, FindingStatus, MigrationLevel } from '../model/types.js';
import { intersectsRegions } from '../parser/jspAnalyzer.js';
import type { ParsedFile } from '../parser/index.js';
import { snippetOf } from './finding.js';
import { RULES, ruleAppliesTo } from './rules/index.js';
import type { FileContext, RawFinding, Rule } from './types.js';

export interface AnalyzeOptions {
  scanTaskId: string;
  /** Rule ids disabled through the Rule Explorer */
  disabledRuleIds?: Set<string>;
  /** Rule ids that have an implemented recipe; injected to keep this module free of recipe imports */
  recipeRuleIds?: Set<string>;
}

function buildContext(parsed: ParsedFile): FileContext {
  return {
    parsed,
    text: parsed.file.content,
    index: parsed.index,
    filePath: parsed.file.path,
    language: parsed.file.language,
    dynamicRegions: parsed.dynamicRegions,
  };
}

/**
 * A finding may only claim an automation level when a recipe actually exists and the
 * hit does not sit inside a dynamic region. Otherwise it degrades to MANUAL, which
 * keeps the dashboard's "auto convertible" number honest.
 */
function normalizeLevel(
  raw: RawFinding,
  rule: Rule,
  ctx: FileContext,
  recipeRuleIds: Set<string>,
): { level: MigrationLevel; touchedDynamic: boolean } {
  const touched = intersectsRegions(ctx.dynamicRegions, raw.startOffset, raw.endOffset);
  let level = raw.migrationLevel;
  if (touched) {
    if (level === 'SAFE' || level === 'CONDITIONAL') level = 'MANUAL';
  }
  if (!touched && (level === 'SAFE' || level === 'CONDITIONAL') && !recipeRuleIds.has(rule.meta.id)) {
    level = 'MANUAL';
  }
  return { level, touchedDynamic: Boolean(touched) };
}

function initialStatus(level: MigrationLevel): FindingStatus {
  return level === 'SAFE' || level === 'CONDITIONAL' ? 'READY_FOR_MIGRATION' : 'DETECTED';
}

export function analyzeParsedFile(parsed: ParsedFile, options: AnalyzeOptions): AnalysisFinding[] {
  const ctx = buildContext(parsed);
  const recipeRuleIds = options.recipeRuleIds ?? new Set<string>();
  const disabled = options.disabledRuleIds ?? new Set<string>();
  const findings: AnalysisFinding[] = [];
  const dedupe = new Set<string>();

  for (const rule of RULES) {
    if (disabled.has(rule.meta.id)) continue;
    if (!ruleAppliesTo(rule, ctx)) continue;

    let raws: RawFinding[];
    try {
      raws = rule.detect(ctx);
    } catch (err) {
      // A misbehaving rule must never abort a scan of the whole project.
      raws = [];
      parsed.problems.push({
        filePath: parsed.file.path,
        phase: 'PARSE',
        message: `Rule ${rule.meta.id} failed: ${(err as Error).message}`,
        recovered: true,
      });
    }

    for (const raw of raws) {
      const key = `${raw.ruleId}:${raw.startOffset}:${raw.endOffset}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);

      const { level, touchedDynamic } = normalizeLevel(raw, rule, ctx, recipeRuleIds);
      const start = ctx.index.positionAt(raw.startOffset);
      const end = ctx.index.positionAt(raw.endOffset);
      const evidence = {
        ...raw.evidence,
        touchesDynamicRegion: raw.evidence.touchesDynamicRegion ?? touchedDynamic,
        detail: { ...raw.evidence.detail, touchesDynamicRegion: touchedDynamic },
      };

      findings.push({
        id: newId('fnd'),
        scanTaskId: options.scanTaskId,
        ruleId: raw.ruleId,
        ruleVersion: rule.meta.version,
        filePath: parsed.file.path,
        language: parsed.file.language,
        startLine: start.line,
        endLine: end.line,
        startColumn: start.column,
        endColumn: end.column,
        startOffset: raw.startOffset,
        endOffset: raw.endOffset,
        category: raw.category,
        severity: raw.severity,
        migrationLevel: level,
        confidence: touchedDynamic ? 'NEEDS_ANALYSIS' : raw.confidence,
        message: raw.message,
        messageKey: raw.messageKey,
        messageParams: raw.messageParams,
        risk: raw.risk,
        evidence,
        recommendation: raw.recommendation,
        snippet: snippetOf(ctx.text, raw.startOffset, raw.endOffset),
        status: initialStatus(level),
        statusUpdatedAt: nowIso(),
      });
    }
  }

  findings.sort((a, b) => {
    if (a.startOffset !== b.startOffset) return a.startOffset - b.startOffset;
    return a.ruleId.localeCompare(b.ruleId);
  });

  return findings;
}

export { ruleAppliesTo };

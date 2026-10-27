import type { FindingEvidence } from '../model/types.js';
import type { FileContext, RawFinding, Rule } from './types.js';

const MAX_SNIPPET = 400;

export function snippetOf(text: string, start: number, end: number): string {
  const raw = text.slice(Math.max(0, start), Math.min(text.length, end));
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_SNIPPET) return trimmed;
  return `${trimmed.slice(0, MAX_SNIPPET)}…`;
}

export interface FindingInput {
  message: string;
  /**
   * Disambiguates rules that emit more than one message shape, e.g. an obsolete vs a
   * still-functional vendor property. Appended to the message key.
   */
  variant?: string;
  risk: string;
  recommendation: string;
  startOffset: number;
  endOffset: number;
  evidence: FindingEvidence;
  severity?: RawFinding['severity'];
  migrationLevel?: RawFinding['migrationLevel'];
  confidence?: RawFinding['confidence'];
}

/**
 * Builds a finding. Every rule must go through this helper so that:
 *  - offsets are clamped to the file bounds
 *  - the range covers at least one character (zero-width nodes degrade to 1)
 *  - severity / migration level / category always fall back to rule defaults
 */
export function makeFinding(rule: Rule, ctx: FileContext, input: FindingInput): RawFinding {
  const max = ctx.text.length;
  let start = Math.max(0, Math.min(input.startOffset, max));
  let end = Math.max(0, Math.min(input.endOffset, max));
  if (end <= start) end = Math.min(max, start + 1);

  const evidence: FindingEvidence = {
    ...input.evidence,
    detail: input.evidence.detail ?? {},
  };

  const messageKey = input.variant ? `rules.${rule.meta.id}.${input.variant}` : `rules.${rule.meta.id}`;
  const messageParams: Record<string, string | number> = {};
  // `container` lives on the evidence object rather than in detail, but several
  // templates need it (e.g. "<script> block"), so it is promoted explicitly.
  if (evidence.container) messageParams.container = evidence.container;
  for (const [key, value] of Object.entries(evidence.detail)) {
    if (typeof value === 'string' || typeof value === 'number') messageParams[key] = value;
    else if (typeof value === 'boolean') messageParams[key] = value ? 'true' : 'false';
  }

  return {
    ruleId: rule.meta.id,
    message: input.message,
    messageKey,
    messageParams,
    risk: input.risk,
    recommendation: input.recommendation,
    severity: input.severity ?? rule.meta.defaultSeverity,
    migrationLevel: input.migrationLevel ?? rule.meta.defaultMigrationLevel,
    confidence: input.confidence ?? 'CONFIRMED',
    category: rule.meta.category,
    startOffset: start,
    endOffset: end,
    evidence,
  };
}

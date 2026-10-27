import type { AnalysisFinding, TextEdit } from '../model/types.js';
import type { ParsedFile } from '../parser/index.js';

export interface RecipeContext {
  /** Current on-disk text, re-read at preview/execute time (never trusted from scan time). */
  text: string;
  parsed: ParsedFile;
}

export interface PreconditionResult {
  ok: boolean;
  reasons: string[];
}

export interface Recipe {
  id: string;
  name: string;
  version: string;
  /** Findings this recipe can act on */
  ruleIds: string[];
  /** SAFE recipes are unconditional; CONDITIONAL ones produce a warning for the reviewer. */
  level: 'SAFE' | 'CONDITIONAL';
  /** Human-readable summary of what changes */
  summary: string;
  /** Semantics the reviewer must verify before executing a CONDITIONAL recipe */
  caveats: string[];
  /** Re-verifies the current source; never relies on data cached from the scan. */
  preconditions(finding: AnalysisFinding, ctx: RecipeContext): PreconditionResult;
  /** Returns minimal text edits, or null when the shape no longer matches. */
  plan(finding: AnalysisFinding, ctx: RecipeContext): TextEdit[] | null;
}

import type {
  Category,
  Confidence,
  FindingEvidence,
  Language,
  MigrationLevel,
  MigrationRule,
  Severity,
} from '../model/types.js';
import type { DynamicRegion } from '../parser/jspAnalyzer.js';
import type { ParsedFile } from '../parser/index.js';
import { LineIndex } from '../parser/lineIndex.js';

/** Raw detector output, not yet bound to a scanTaskId or id */
export interface RawFinding {
  ruleId: string;
  message: string;
  messageKey: string;
  messageParams: Record<string, string | number>;
  risk: string;
  recommendation: string;
  severity: Severity;
  migrationLevel: MigrationLevel;
  confidence: Confidence;
  category: Category;
  startOffset: number;
  endOffset: number;
  evidence: FindingEvidence;
}

export interface FileContext {
  parsed: ParsedFile;
  /** Original file text (for JSP this is not the masked string) */
  text: string;
  index: LineIndex;
  filePath: string;
  language: Language;
  dynamicRegions: DynamicRegion[];
}

export interface Rule {
  meta: MigrationRule;
  detect(ctx: FileContext): RawFinding[];
}

export interface RuleDraft {
  meta: Omit<MigrationRule, 'enabled' | 'testStatus'> & {
    testStatus?: MigrationRule['testStatus'];
  };
  detect(ctx: FileContext): RawFinding[];
}

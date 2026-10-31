import type { AnalysisFinding } from '../model/types.js';
import { findingKey } from './compare.js';

export interface ManualFixVerification {
  previous: AnalysisFinding;
  current: AnalysisFinding | null;
  result: 'VALIDATED' | 'VALIDATION_FAILED';
}

export function verifyManualFixes(options: {
  previous: AnalysisFinding[];
  current: AnalysisFinding[];
  parsedFiles: Set<string>;
  disabledRules: Set<string>;
}): ManualFixVerification[] {
  const currentByKey = new Map<string, AnalysisFinding[]>();
  for (const finding of options.current) {
    const key = findingKey(finding);
    const list = currentByKey.get(key) ?? [];
    list.push(finding);
    currentByKey.set(key, list);
  }

  const outcomes: ManualFixVerification[] = [];
  for (const prior of options.previous) {
    if (!options.parsedFiles.has(prior.filePath)) continue;
    if (options.disabledRules.has(prior.ruleId)) continue;
    const match = currentByKey.get(findingKey(prior))?.shift() ?? null;
    if (prior.status === 'FIXED_IN_CODE') {
      outcomes.push({ previous: prior, current: match, result: match ? 'VALIDATION_FAILED' : 'VALIDATED' });
    } else if (prior.status === 'VALIDATION_FAILED' && !match) {
      outcomes.push({ previous: prior, current: null, result: 'VALIDATED' });
    }
  }
  return outcomes;
}

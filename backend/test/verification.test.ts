import { describe, expect, it } from 'vitest';
import { verifyManualFixes } from '../src/core/verification.js';
import type { AnalysisFinding } from '../src/model/types.js';

function finding(overrides: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    id: 'fnd_1',
    scanTaskId: 'scn_1',
    ruleId: 'WL-JS-001',
    ruleVersion: '1.0.0',
    filePath: 'js/a.js',
    language: 'javascript',
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 20,
    startOffset: 0,
    endOffset: 19,
    category: 'JS_API',
    severity: 'HIGH',
    migrationLevel: 'MANUAL',
    confidence: 'CONFIRMED',
    message: 'attachEvent',
    messageKey: 'rules.WL-JS-001',
    messageParams: {},
    risk: '',
    recommendation: '',
    evidence: { kind: 'MemberExpression', matched: 'attachEvent', detail: {} },
    snippet: 'attachEvent',
    status: 'DETECTED',
    statusUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const allFiles = new Set(['js/a.js']);

describe('manual fix verification', () => {
  it('validates a marked fix only when the finding is gone', () => {
    const previous = finding({ id: 'fnd_old', status: 'FIXED_IN_CODE' });
    const outcomes = verifyManualFixes({
      previous: [previous],
      current: [],
      parsedFiles: allFiles,
      disabledRules: new Set(),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe('VALIDATED');
    expect(outcomes[0].previous.id).toBe('fnd_old');
    expect(outcomes[0].current).toBeNull();
  });

  it('fails a marked fix that is still present and pairs it with the current finding', () => {
    const previous = finding({ id: 'fnd_old', status: 'FIXED_IN_CODE' });
    const current = finding({ id: 'fnd_new', scanTaskId: 'scn_2' });
    const outcomes = verifyManualFixes({
      previous: [previous],
      current: [current],
      parsedFiles: allFiles,
      disabledRules: new Set(),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe('VALIDATION_FAILED');
    expect(outcomes[0].current?.id).toBe('fnd_new');
  });

  it('resolves an earlier failed verification when the finding disappears later', () => {
    const previous = finding({ id: 'fnd_old', status: 'VALIDATION_FAILED' });
    const outcomes = verifyManualFixes({
      previous: [previous],
      current: [],
      parsedFiles: allFiles,
      disabledRules: new Set(),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe('VALIDATED');
  });

  it('leaves a still-present failed verification alone', () => {
    const previous = finding({ id: 'fnd_old', status: 'VALIDATION_FAILED' });
    const outcomes = verifyManualFixes({
      previous: [previous],
      current: [finding({ id: 'fnd_new', scanTaskId: 'scn_2' })],
      parsedFiles: allFiles,
      disabledRules: new Set(),
    });
    expect(outcomes).toHaveLength(0);
  });

  it('matches duplicate snippets one-for-one instead of letting one occurrence vouch for another', () => {
    const previous = [
      finding({ id: 'fnd_fixed', status: 'FIXED_IN_CODE', startLine: 1 }),
      finding({ id: 'fnd_other', status: 'DETECTED', startLine: 9 }),
    ];
    const current = [finding({ id: 'fnd_survivor', scanTaskId: 'scn_2', startLine: 1 })];
    const outcomes = verifyManualFixes({
      previous,
      current,
      parsedFiles: allFiles,
      disabledRules: new Set(),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].previous.id).toBe('fnd_fixed');
    expect(outcomes[0].result).toBe('VALIDATION_FAILED');
  });

  it('does not draw conclusions from a file that was not parsed, or from a disabled rule', () => {
    const unparsed = finding({ id: 'fnd_unparsed', filePath: 'js/broken.js', status: 'FIXED_IN_CODE' });
    const disabled = finding({ id: 'fnd_disabled', ruleId: 'WL-JS-002', status: 'FIXED_IN_CODE' });
    const outcomes = verifyManualFixes({
      previous: [unparsed, disabled],
      current: [],
      parsedFiles: allFiles,
      disabledRules: new Set(['WL-JS-002']),
    });
    expect(outcomes).toHaveLength(0);
  });

  it('ignores findings that were never marked fixed', () => {
    const outcomes = verifyManualFixes({
      previous: [finding({ status: 'DETECTED' })],
      current: [],
      parsedFiles: allFiles,
      disabledRules: new Set(),
    });
    expect(outcomes).toHaveLength(0);
  });
});

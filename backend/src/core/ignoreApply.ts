import type { Store } from '../storage/store.js';
import { DISABLED_RULE_NOTE_PREFIX, findIgnoreMatch, ignoreNote, isEngineNote } from './ignoreRules.js';

export interface ApplyIgnoreResult {
  scanTaskId: string;
  /** Findings newly silenced by an ignore rule. */
  ignored: number;
  /** Findings silenced because their rule is disabled. */
  disabled: number;
  /** Findings restored because neither reason applies any more. */
  unignored: number;
  /** Findings left as they were. */
  unchanged: number;
}

/**
 * Recomputes ignore-rule state for one existing scan.
 *
 * Creating, disabling or deleting a rule would otherwise only show its effect on the next
 * scan, which makes the impact preview look like a lie. This applies the current rules to
 * the stored findings immediately, in both directions:
 *
 * - a finding that now matches a rule becomes IGNORED (with the rule and reason recorded);
 * - a finding silenced by a rule that no longer matches is restored to its initial status.
 *
 * Manual ignores are never touched: only notes written by this module are undone.
 */
export function applyIgnoreRules(store: Store, scanId: string): ApplyIgnoreResult {
  const scan = store.getScan(scanId);
  if (!scan) throw new Error(`Unknown scan ${scanId}`);

  const rules = store.listIgnoreRules(scan.projectId);

  // Rule enable/disable lives in the same store and has the same problem: a rule turned off
  // after a scan keeps reporting through that scan's stored findings.
  const disabledRuleIds = new Set<string>();
  for (const [ruleId, enabled] of store.listRuleStates()) {
    if (!enabled) disabledRuleIds.add(ruleId);
  }

  const findings = store.listAllFindings(scanId);

  let ignored = 0;
  let disabled = 0;
  let unignored = 0;
  let unchanged = 0;

  for (const finding of findings) {
    const match = findIgnoreMatch(finding, rules);
    const silencedByEngine = finding.status === 'IGNORED' && isEngineNote(finding.statusNote);

    if (match && finding.status !== 'IGNORED') {
      store.updateFindingStatus(finding.id, 'IGNORED', 'system:ignore-rule', ignoreNote(match.rule, match.reason));
      ignored += 1;
      continue;
    }

    const ruleOff = !match && disabledRuleIds.has(finding.ruleId);
    if (ruleOff && finding.status !== 'IGNORED') {
      store.updateFindingStatus(
        finding.id,
        'IGNORED',
        'system:rule-state',
        `${DISABLED_RULE_NOTE_PREFIX} (${finding.ruleId}); re-enable the rule to see it again.`,
      );
      disabled += 1;
      continue;
    }

    if (!match && !ruleOff && silencedByEngine) {
      const restored = finding.migrationLevel === 'SAFE' || finding.migrationLevel === 'CONDITIONAL'
        ? 'READY_FOR_MIGRATION'
        : 'DETECTED';
      store.updateFindingStatus(finding.id, restored, 'system:ignore-rule', 'Neither a rule nor a disabled rule applies after re-evaluation');
      unignored += 1;
      continue;
    }

    unchanged += 1;
  }

  return { scanTaskId: scanId, ignored, disabled, unignored, unchanged };
}

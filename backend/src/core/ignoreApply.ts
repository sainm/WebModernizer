import type { Store } from '../storage/store.js';
import { findIgnoreMatch, ignoreNote } from './ignoreRules.js';

export interface ApplyIgnoreResult {
  scanTaskId: string;
  /** Findings newly silenced by a rule. */
  ignored: number;
  /** Findings restored because no rule matches them any more. */
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
  const findings = store.listAllFindings(scanId);

  let ignored = 0;
  let unignored = 0;
  let unchanged = 0;

  for (const finding of findings) {
    const match = findIgnoreMatch(finding, rules);
    const wasRuleIgnored = finding.status === 'IGNORED' && (finding.statusNote ?? '').startsWith('Ignored by project rule');

    if (match && finding.status !== 'IGNORED') {
      store.updateFindingStatus(finding.id, 'IGNORED', 'system:ignore-rule', ignoreNote(match.rule, match.reason));
      ignored += 1;
      continue;
    }

    if (!match && wasRuleIgnored) {
      const restored = finding.migrationLevel === 'SAFE' || finding.migrationLevel === 'CONDITIONAL'
        ? 'READY_FOR_MIGRATION'
        : 'DETECTED';
      store.updateFindingStatus(finding.id, restored, 'system:ignore-rule', 'No matching ignore rule after re-evaluation');
      unignored += 1;
      continue;
    }

    unchanged += 1;
  }

  return { scanTaskId: scanId, ignored, unignored, unchanged };
}

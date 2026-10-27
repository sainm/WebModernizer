import { describe, expect, it } from 'vitest';
import { RULES } from '../src/analysis/rules/index.js';
import { analyzeText } from './helpers.js';
import { FIXTURES } from './ruleFixtures.js';
// Contract test across the package boundary: the analyzer emits message keys, the UI owns
// the translations. Importing the dictionary here is the only way to prove the two sides
// have not drifted apart. `ruleMessages.ts` is dependency-free, so no React is loaded.
import { RULE_MESSAGES, renderRuleMessage, localizedMessage } from '../../web/src/ruleMessages.js';

const RULE_IDS = new Set(RULES.map((rule) => rule.meta.id));

/** "rules.WL-CSS-004.obsolete" -> "WL-CSS-004" */
function ruleIdOf(key: string): string {
  return key.split('.').slice(1, 2)[0] ?? '';
}

describe('localized finding messages', () => {
  it('emits a message key for every finding the rules produce', () => {
    const failures: string[] = [];
    for (const fixture of FIXTURES) {
      const { findings } = analyzeText(fixture.file, fixture.code);
      const hits = findings.filter((finding) => finding.ruleId === fixture.id);
      if (hits.length === 0) {
        failures.push(`${fixture.id}: no finding to check`);
        continue;
      }
      for (const finding of hits) {
        if (!finding.messageKey.startsWith('rules.')) failures.push(`${fixture.id}: key "${finding.messageKey}"`);
        if (typeof finding.messageParams !== 'object' || finding.messageParams === null) {
          failures.push(`${fixture.id}: missing params`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('has zh and ja templates for every registered rule', () => {
    const missing: string[] = [];
    for (const ruleId of RULE_IDS) {
      const hasChinese = Object.keys(RULE_MESSAGES.zh).some((key) => ruleIdOf(key) === ruleId);
      const hasJapanese = Object.keys(RULE_MESSAGES.ja).some((key) => ruleIdOf(key) === ruleId);
      if (!hasChinese) missing.push(`${ruleId} (zh)`);
      if (!hasJapanese) missing.push(`${ruleId} (ja)`);
    }
    expect(missing, `rules without a translated summary: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the two lexicons in sync', () => {
    expect(Object.keys(RULE_MESSAGES.ja).sort()).toEqual(Object.keys(RULE_MESSAGES.zh).sort());
  });

  it('does not translate a rule that no longer exists', () => {
    const orphans = [...Object.keys(RULE_MESSAGES.zh), ...Object.keys(RULE_MESSAGES.ja)].filter((key) => !RULE_IDS.has(ruleIdOf(key)));
    expect(orphans, `stale translation keys: ${[...new Set(orphans)].join(', ')}`).toEqual([]);
  });

  it('renders every observed message without leaving a placeholder behind', () => {
    const failures: string[] = [];
    for (const fixture of FIXTURES) {
      const { findings } = analyzeText(fixture.file, fixture.code);
      for (const finding of findings.filter((item) => item.ruleId === fixture.id)) {
        for (const locale of ['zh', 'ja'] as const) {
          const template = RULE_MESSAGES[locale][finding.messageKey];
          if (!template) continue; // covered by the "missing template" test above
          const rendered = renderRuleMessage(template, finding.messageParams);
          if (rendered === null) failures.push(`${finding.messageKey} (${locale}) has an unfilled placeholder`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('falls back to the analyzer text in English or when a placeholder cannot be filled', () => {
    const finding = { message: 'Uses IE-only attachEvent("onclick", ...)', messageKey: 'rules.WL-JS-001', messageParams: { eventName: 'onclick' } };
    expect(localizedMessage('en', finding)).toBe(finding.message);
    expect(localizedMessage('zh', finding)).toContain('attachEvent');

    // HTML-005 has no classid when the control is an OLE embed: the template would show
    // "{classid}", so the English message must win instead.
    const ole = { message: 'Embeds an ActiveX/OLE control', messageKey: 'rules.WL-HTML-005', messageParams: {} };
    expect(localizedMessage('zh', ole)).toBe(ole.message);

    const unknown = { message: 'Something new', messageKey: 'rules.WL-FUTURE-001', messageParams: {} };
    expect(localizedMessage('ja', unknown)).toBe('Something new');
  });
});

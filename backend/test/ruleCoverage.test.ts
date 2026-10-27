import { describe, expect, it } from 'vitest';
import { RULES } from '../src/analysis/rules/index.js';
import { analyzeText, byRule } from './helpers.js';
import { FIXTURES } from './ruleFixtures.js';

/**
 * One firing fixture per rule. This is the guard against a rule shipping with a
 * "Covered" badge that nobody ever verified: the test asserts that every rule in the
 * registry fires on its fixture, and that no fixture is left without a matching rule.
 *
 * When a new rule is added, this file fails until a fixture is provided.
 */
describe('rule coverage', () => {
  it('has a fixture for every registered rule', () => {
    const registered = new Set(RULES.map((rule) => rule.meta.id));
    const fixtures = new Set(FIXTURES.map((fixture) => fixture.id));
    const missing = [...registered].filter((id) => !fixtures.has(id));
    const orphaned = [...fixtures].filter((id) => !registered.has(id));
    expect(missing, `rules without a fixture: ${missing.join(', ')}`).toEqual([]);
    expect(orphaned, `fixtures for unknown rules: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('marks every rule as covered only because a fixture actually fires', () => {
    const failures: string[] = [];
    for (const fixture of FIXTURES) {
      const { findings } = analyzeText(fixture.file, fixture.code);
      if (byRule(findings, fixture.id).length === 0) failures.push(fixture.id);
    }
    expect(failures, `rules that did not fire on their fixture: ${failures.join(', ')}`).toEqual([]);
  });

  it('reports a test status that matches the coverage table', () => {
    const uncovered = RULES.filter((rule) => rule.meta.testStatus !== 'COVERED').map((rule) => rule.meta.id);
    expect(uncovered, `rules claiming less than full coverage: ${uncovered.join(', ')}`).toEqual([]);
  });
});

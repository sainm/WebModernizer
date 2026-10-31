import { describe, expect, it } from 'vitest';
import { recipeForFinding } from '../src/recipes/registry.js';
import { analyzeText, byRule } from './helpers.js';

describe('inline style attributes as declarations', () => {
  it('detects filter, zoom, -ms- and behavior declarations inside a style attribute', () => {
    const html =
      '<html><body><div style="filter: alpha(opacity=50); zoom: 1; -ms-transform: translateZ(0); behavior: url(x.htc);">x</div></body></html>';
    const findings = analyzeText('page.html', html).findings;
    expect(byRule(findings, 'WL-CSS-003')).toHaveLength(1);
    expect(byRule(findings, 'WL-CSS-003')[0].migrationLevel).toBe('MANUAL');
    expect(byRule(findings, 'WL-CSS-006')).toHaveLength(1);
    expect(byRule(findings, 'WL-CSS-004')).toHaveLength(1);
    expect(byRule(findings, 'WL-CSS-004')[0].migrationLevel).toBe('MANUAL');
    expect(byRule(findings, 'WL-CSS-002')).toHaveLength(1);
    expect(byRule(findings, 'WL-CSS-005')).toHaveLength(0);
  });

  it('maps each inline finding to the declaration text inside the attribute', () => {
    const html = ['<html><body>', '<div style="width: expression(1); filter: alpha(opacity=50);">x</div>', '</body></html>'].join(
      '\n',
    );
    const findings = analyzeText('page.html', html).findings;
    const line = html.split('\n')[1];
    const expression = byRule(findings, 'WL-CSS-001')[0];
    expect(line.slice(expression.startColumn - 1, expression.startColumn - 1 + 12)).toBe('expression(1');
    const filter = byRule(findings, 'WL-CSS-003')[0];
    expect(line.slice(filter.startColumn - 1, filter.startColumn - 1 + 6)).toBe('filter');
    expect(filter.evidence.detail.property).toBe('filter');
  });

  it('reports each inline declaration once and keeps star hacks separate from zoom', () => {
    const html =
      '<html><body><div style="width: expression(1); height: expression(2); *zoom: 1; color: red;">x</div></body></html>';
    const findings = analyzeText('page.html', html).findings;
    expect(byRule(findings, 'WL-CSS-001')).toHaveLength(2);
    expect(byRule(findings, 'WL-CSS-005')).toHaveLength(1);
    expect(byRule(findings, 'WL-CSS-006')).toHaveLength(0);
  });

  it('still refuses to rewrite an inline declaration', () => {
    const html = '<html><body><div style="filter: alpha(opacity=50);">x</div></body></html>';
    const { findings, parsed } = analyzeText('page.html', html);
    const finding = byRule(findings, 'WL-CSS-003')[0];
    expect(finding.migrationLevel).toBe('MANUAL');
    const recipe = recipeForFinding(finding);
    expect(recipe).not.toBeNull();
    const outcome = recipe!.preconditions(finding, { text: html, parsed });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.join(' ')).toContain('inline style attribute');
  });
});

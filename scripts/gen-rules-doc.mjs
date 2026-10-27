// Generates docs/RULES.md from the rule registry so the document cannot drift from code.
import { writeFileSync } from 'node:fs';
import { RULES } from '../backend/dist/analysis/rules/index.js';
import { RECIPES, RECIPE_BY_RULE } from '../backend/dist/recipes/registry.js';

const rows = RULES.map((rule) => {
  const recipe = RECIPE_BY_RULE.get(rule.meta.id);
  return [
    rule.meta.id,
    rule.meta.name,
    rule.meta.language,
    rule.meta.category,
    rule.meta.defaultSeverity,
    rule.meta.defaultMigrationLevel,
    recipe ? recipe.id : '—',
    rule.meta.tags.join(', '),
  ];
});

const byCategory = {};
for (const rule of RULES) byCategory[rule.meta.category] = (byCategory[rule.meta.category] ?? 0) + 1;

const lines = [];
lines.push('# Rule catalog');
lines.push('');
lines.push('Generated from the running rule registry, so this file cannot drift from the code.');
lines.push(`Total: **${RULES.length} rules**, **${RECIPES.length} recipes**.`);
lines.push('');
lines.push('## Distribution by category');
lines.push('');
lines.push('| Category | Rules |');
lines.push('| --- | --- |');
for (const [category, count] of Object.entries(byCategory)) lines.push(`| ${category} | ${count} |`);
lines.push('');
lines.push('## Automation levels');
lines.push('');
lines.push('- **SAFE** — the recipe preconditions prove equivalence on the matched shape, and the test suite covers the transformation.');
lines.push('- **CONDITIONAL** — the rewrite is mechanically valid but changes semantics a human must confirm (event `this`, cancelability, listener life cycle).');
lines.push('- **MANUAL** — detected and located, but no safe automatic rewrite exists in phase one.');
lines.push('- **UNSUPPORTED** — the capability does not exist in Chrome at all (ActiveX, VBScript, `.htc` behaviors); a product decision is required.');
lines.push('');
lines.push('A rule may only report SAFE or CONDITIONAL when a recipe is registered for it. The engine enforces this at analysis time, so the dashboard "auto convertible" count can never include a finding with nothing to execute.');
lines.push('');
lines.push('## Rules');
lines.push('');
lines.push('| Rule | Name | Language | Category | Severity | Automation | Recipe | Tags |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
lines.push('');
lines.push('## Recipes');
lines.push('');
lines.push('| Recipe | Name | Level | Rules | Summary |');
lines.push('| --- | --- | --- | --- | --- |');
for (const recipe of RECIPES) {
  lines.push(`| ${recipe.id} | ${recipe.name} | ${recipe.level} | ${recipe.ruleIds.join(', ')} | ${recipe.summary} |`);
}
lines.push('');
lines.push('## Evidence discipline');
lines.push('');
lines.push('Every finding carries `evidence.kind`, `evidence.matched`, and a structured `detail` map. Matching is AST-based for JavaScript and CSS declarations, so identical text inside comments or string literals never produces a finding. The regression test for exactly that case lives in `backend/test/rules.test.ts`.');
lines.push('');

writeFileSync(new URL('../docs/RULES.md', import.meta.url), `${lines.join('\n')}\n`);
console.log(`docs/RULES.md: ${RULES.length} rules, ${RECIPES.length} recipes`);

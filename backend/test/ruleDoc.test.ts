import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/analysis/rules/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const document = readFileSync(resolve(here, '../../docs/RULES.md'), 'utf8');

describe('rule catalog document', () => {
  it('lists exactly the registered rules', () => {
    const documented = [...document.matchAll(/^\| (WL-[A-Z]+-\d{3}) \|/gm)].map((match) => match[1]);
    const registered = RULES.map((rule) => rule.meta.id);
    expect(documented.sort()).toEqual(registered.sort());
  });

  it('states the current rule count', () => {
    expect(document).toContain(`Total: **${RULES.length} rules**`);
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Release bookkeeping drift is silent: a version bump without a changelog entry, or a workspace
 * left behind at the old number, only shows up when someone reads a rendered page months later.
 * These are cheap assertions against the files themselves.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const readJson = (path: string): { version?: string } => JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

describe('release bookkeeping', () => {
  const version = readJson(join(root, 'package.json')).version;

  it('keeps every workspace on the same version', () => {
    expect(version).toBeDefined();
    expect(readJson(join(root, 'backend/package.json')).version).toBe(version);
    expect(readJson(join(root, 'web/package.json')).version).toBe(version);
  });

  it('has a dated changelog section for the version being shipped', () => {
    expect(version).toBeDefined();
    const heading = new RegExp(`^## \\[${(version as string).replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
    expect(changelog).toMatch(heading);
  });

  it('keeps Unreleased above the newest release', () => {
    const unreleased = changelog.indexOf('## [Unreleased]');
    const released = changelog.indexOf(`## [${version}]`);
    expect(unreleased).toBeGreaterThan(-1);
    expect(released).toBeGreaterThan(unreleased);
  });

  it('does not ship an empty changelog section', () => {
    const start = changelog.indexOf(`## [${version}]`);
    const rest = changelog.slice(start);
    const next = rest.indexOf('\n## [', 1);
    const section = next === -1 ? rest : rest.slice(0, next);
    // A version heading with no bullets means the entry was forgotten, not that nothing changed.
    expect(section.split('\n').filter((line) => line.startsWith('- ')).length).toBeGreaterThan(0);
  });
});

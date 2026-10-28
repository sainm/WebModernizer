import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { countIgnoreMatches, findIgnoreMatch, globToRegExp, pathMatches } from '../src/core/ignoreRules.js';
import { applyIgnoreRules } from '../src/core/ignoreApply.js';
import { buildSummary } from '../src/core/report.js';
import { Store } from '../src/storage/store.js';
import type { IgnoreRule, ScanStatus } from '../src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '../../examples/legacy-app');
const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

describe('path patterns', () => {
  it('keeps * inside one segment', () => {
    expect(pathMatches('js/*.js', 'js/app.js')).toBe(true);
    expect(pathMatches('js/*.js', 'js/lib/app.js')).toBe(false);
  });

  it('lets ** cross segments, including none', () => {
    expect(pathMatches('**/*.js', 'app.js')).toBe(true);
    expect(pathMatches('**/*.js', 'js/lib/app.js')).toBe(true);
    expect(pathMatches('vendor/**', 'vendor/lib/x.css')).toBe(true);
    expect(pathMatches('vendor/**', 'src/x.css')).toBe(false);
  });

  it('supports ? and literal dots', () => {
    expect(pathMatches('a/?.js', 'a/b.js')).toBe(true);
    expect(pathMatches('a/?.js', 'a/bc.js')).toBe(false);
    expect(globToRegExp('a.css').test('axcss')).toBe(false);
  });

  it('treats a missing pattern as "match everything"', () => {
    expect(pathMatches(null, 'anything/at/all.js')).toBe(true);
  });
});

function rule(overrides: Partial<IgnoreRule>): IgnoreRule {
  return {
    id: 'ign_1',
    projectId: 'prj_1',
    ruleId: null,
    pathPattern: null,
    reason: 'accepted',
    enabled: true,
    createdBy: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ignore rule matching', () => {
  const finding = { ruleId: 'WL-CSS-004', filePath: 'css/ie-fixes.css' };

  it('matches on rule, on path, or on both', () => {
    expect(findIgnoreMatch(finding, [rule({ ruleId: 'WL-CSS-004' })])).not.toBeNull();
    expect(findIgnoreMatch(finding, [rule({ pathPattern: 'css/*.css' })])).not.toBeNull();
    expect(findIgnoreMatch(finding, [rule({ ruleId: 'WL-CSS-004', pathPattern: 'css/*.css' })])).not.toBeNull();
  });

  it('does not match a different rule or a different path', () => {
    expect(findIgnoreMatch(finding, [rule({ ruleId: 'WL-JS-001' })])).toBeNull();
    expect(findIgnoreMatch(finding, [rule({ pathPattern: 'js/**' })])).toBeNull();
    expect(findIgnoreMatch(finding, [rule({ ruleId: 'WL-CSS-004', pathPattern: 'js/**' })])).toBeNull();
  });

  it('skips disabled rules', () => {
    expect(findIgnoreMatch(finding, [rule({ ruleId: 'WL-CSS-004', enabled: false })])).toBeNull();
  });

  it('returns the first matching rule so the reason is deterministic', () => {
    const first = rule({ id: 'ign_a', reason: 'first' });
    const second = rule({ id: 'ign_b', reason: 'second' });
    expect(findIgnoreMatch(finding, [first, second])?.reason).toBe('first');
  });
});

const harnesses: Array<{ dir: string; store: Store }> = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

async function scanWithIgnoreRules(): Promise<{ store: Store; scanId: string; projectId: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-ignore-'));
  const projectDir = join(dir, 'legacy-app');
  cpSync(exampleRoot, projectDir, { recursive: true });
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });

  const scans = new ScanManager(store);
  const project = store.createProject('Ignore Test', projectDir, defaultProjectConfig());
  // Accept the CSS vendor-prefix debt for this project.
  store.createIgnoreRule({
    projectId: project.id,
    ruleId: 'WL-CSS-004',
    pathPattern: null,
    reason: 'We ship the prefixed property on purpose',
    enabled: true,
    createdBy: 'test',
  });
  const scan = store.createScan(project, defaultProjectConfig());
  scans.start(scan.id);

  const started = Date.now();
  while (Date.now() - started < 30000) {
    const current = store.getScan(scan.id);
    if (current && TERMINAL.includes(current.status)) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  return { store, scanId: scan.id, projectId: project.id };
}

describe('ignore rules at scan time', () => {
  it('silences matching findings and records why', async () => {
    const { store, scanId } = await scanWithIgnoreRules();
    const findings = store.listAllFindings(scanId);
    const silenced = findings.filter((finding) => finding.ruleId === 'WL-CSS-004');
    expect(silenced.length).toBeGreaterThan(0);
    for (const finding of silenced) {
      expect(finding.status).toBe('IGNORED');
      expect(finding.statusNote).toContain('We ship the prefixed property on purpose');
    }
    // Everything else is untouched.
    const others = findings.filter((finding) => finding.ruleId !== 'WL-CSS-004');
    expect(others.every((finding) => finding.status !== 'IGNORED')).toBe(true);

    const summary = buildSummary(store, scanId);
    expect(summary.totals.ignored).toBe(silenced.length);
  });

  it('refuses to migrate an ignored finding', async () => {
    const { store, scanId } = await scanWithIgnoreRules();
    const ignored = store.listAllFindings(scanId).find((finding) => finding.ruleId === 'WL-CSS-004' && finding.migrationLevel === 'CONDITIONAL');
    expect(ignored).toBeDefined();

    const plan = new MigrationService(store).preview({ scanTaskId: scanId, findingIds: [ignored!.id] });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].applicable).toBe(false);
    expect(plan.items[0].blockedReasons.join(' ')).toMatch(/ignored by a project rule/);
  });
});

describe('ignore rule impact preview', () => {
  const findings = [
    { ruleId: 'WL-CSS-004', filePath: 'css/main.css', status: 'DETECTED' as const },
    { ruleId: 'WL-CSS-004', filePath: 'css/ie-fixes.css', status: 'DETECTED' as const },
    { ruleId: 'WL-CSS-004', filePath: 'css/ie-fixes.css', status: 'IGNORED' as const },
    { ruleId: 'WL-CSS-005', filePath: 'css/main.css', status: 'DETECTED' as const },
    { ruleId: 'WL-JS-001', filePath: 'js/legacy.js', status: 'DETECTED' as const },
  ];

  it('counts matched, already ignored and newly ignored separately', () => {
    const impact = countIgnoreMatches(findings, { ruleId: 'WL-CSS-004', pathPattern: 'css/**', enabled: true });
    expect(impact.matched).toBe(3);
    expect(impact.alreadyIgnored).toBe(1);
    expect(impact.newlyIgnored).toBe(2);
    expect(impact.byRule).toEqual([{ ruleId: 'WL-CSS-004', count: 3 }]);
  });

  it('breaks the impact down by rule, biggest first', () => {
    const impact = countIgnoreMatches(findings, { ruleId: null, pathPattern: 'css/**', enabled: true });
    expect(impact.matched).toBe(4);
    expect(impact.byRule[0]).toEqual({ ruleId: 'WL-CSS-004', count: 3 });
    expect(impact.byRule[1]).toEqual({ ruleId: 'WL-CSS-005', count: 1 });
  });

  it('reports zero when nothing matches, instead of pretending', () => {
    const impact = countIgnoreMatches(findings, { ruleId: 'WL-HTML-001', pathPattern: null, enabled: true });
    expect(impact.matched).toBe(0);
    expect(impact.newlyIgnored).toBe(0);
    expect(impact.byRule).toEqual([]);
  });

  it('handles an empty scan', () => {
    const impact = countIgnoreMatches([], { ruleId: null, pathPattern: null, enabled: true });
    expect(impact.matched).toBe(0);
  });
});

describe('applying rules to an existing scan', () => {
  async function scanOnly(): Promise<{ store: Store; scanId: string; projectId: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'weblift-apply-'));
    const projectDir = join(dir, 'legacy-app');
    cpSync(exampleRoot, projectDir, { recursive: true });
    const store = new Store({ dataDir: join(dir, 'data') });
    harnesses.push({ dir, store });

    const scans = new ScanManager(store);
    const project = store.createProject('Apply Test', projectDir, defaultProjectConfig());
    const scan = store.createScan(project, defaultProjectConfig());
    scans.start(scan.id);

    const started = Date.now();
    while (Date.now() - started < 30000) {
      const current = store.getScan(scan.id);
      if (current && TERMINAL.includes(current.status)) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    return { store, scanId: scan.id, projectId: project.id };
  }

  it('silences matching findings of the scan that already ran', async () => {
    const { store, scanId, projectId } = await scanOnly();
    expect(store.listAllFindings(scanId).filter((f) => f.status === 'IGNORED')).toHaveLength(0);

    store.createIgnoreRule({
      projectId,
      ruleId: 'WL-CSS-005',
      pathPattern: 'css/**',
      reason: 'hacks are removed in a later batch',
      enabled: true,
      createdBy: 'test',
    });

    const result = applyIgnoreRules(store, scanId);
    expect(result.ignored).toBeGreaterThan(0);

    const silenced = store.listAllFindings(scanId).filter((f) => f.ruleId === 'WL-CSS-005');
    expect(silenced.every((f) => f.status === 'IGNORED')).toBe(true);
    expect(silenced[0].statusNote).toContain('hacks are removed in a later batch');
  });

  it('restores findings when the rule stops applying', async () => {
    const { store, scanId, projectId } = await scanOnly();
    const rule = store.createIgnoreRule({
      projectId,
      ruleId: 'WL-CSS-005',
      pathPattern: 'css/**',
      reason: 'temporary',
      enabled: true,
      createdBy: 'test',
    });
    applyIgnoreRules(store, scanId);

    store.setIgnoreRuleEnabled(rule.id, false);
    const result = applyIgnoreRules(store, scanId);
    expect(result.unignored).toBeGreaterThan(0);

    const restored = store.listAllFindings(scanId).filter((f) => f.ruleId === 'WL-CSS-005');
    expect(restored.every((f) => f.status !== 'IGNORED')).toBe(true);
    // SAFE/CONDITIONAL findings go back to "ready", everything else to "detected".
    for (const finding of restored) {
      const expected = finding.migrationLevel === 'SAFE' || finding.migrationLevel === 'CONDITIONAL' ? 'READY_FOR_MIGRATION' : 'DETECTED';
      expect(finding.status).toBe(expected);
    }
  });

  it('never undoes a manual ignore', async () => {
    const { store, scanId, projectId } = await scanOnly();
    const manual = store.listAllFindings(scanId).find((f) => f.ruleId === 'WL-JS-003')!;
    store.updateFindingStatus(manual.id, 'IGNORED', 'user', 'someone decided this by hand');

    store.createIgnoreRule({
      projectId,
      ruleId: 'WL-CSS-005',
      pathPattern: 'css/**',
      reason: 'css debt',
      enabled: true,
      createdBy: 'test',
    });

    applyIgnoreRules(store, scanId);
    const after = store.getFinding(manual.id)!;
    expect(after.status).toBe('IGNORED');
    expect(after.statusNote).toBe('someone decided this by hand');
  });

  it('is idempotent when nothing changes', async () => {
    const { store, scanId, projectId } = await scanOnly();
    store.createIgnoreRule({
      projectId,
      ruleId: 'WL-CSS-005',
      pathPattern: 'css/**',
      reason: 'css debt',
      enabled: true,
      createdBy: 'test',
    });
    const first = applyIgnoreRules(store, scanId);
    const second = applyIgnoreRules(store, scanId);
    expect(second.ignored).toBe(0);
    expect(second.unignored).toBe(0);
    expect(second.unchanged).toBe(first.unchanged + first.ignored);
  });
});

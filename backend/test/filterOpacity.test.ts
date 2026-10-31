import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import type { ScanStatus } from '../src/model/types.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';
import { analyzeText, byRule } from './helpers.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];
const FILE = 'css/app.css';
const SOURCE = `.amount { filter: alpha(opacity=90); }
.header { -ms-filter: "progid:DXImageTransform.Microsoft.Alpha(Opacity=85)" !important; }
.full { filter: alpha(opacity=100); }
.mixed { filter: alpha(opacity=50) progid:DXImageTransform.Microsoft.gradient(startColorstr='#fff', endColorstr='#000'); }
.shadow { -ms-filter: "progid:DXImageTransform.Microsoft.Shadow(direction=135,strength=2)"; }
`;

const harnesses: Array<{ dir: string; store: Store }> = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

async function waitForScan(store: Store, scanId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const scan = store.getScan(scanId);
    if (scan && TERMINAL.includes(scan.status)) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('scan did not finish in time');
}

async function setup(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-filter-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'css'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Filter opacity', root, config);
  const manager = new ScanManager(store, { lockWaitMs: 0 });
  const service = new MigrationService(store, { lockWaitMs: 0 });
  const scan = async () => {
    const task = store.createScan(project, config, ruleSignature());
    manager.start(task.id);
    await waitForScan(store, task.id);
    return store.getScan(task.id)!;
  };
  return { file, store, service, scan };
}

describe('alpha-only IE filter migration', () => {
  it('marks alpha-only values conditional and leaves combined filters manual', () => {
    const findings = byRule(analyzeText(FILE, SOURCE).findings, 'WL-CSS-003');
    expect(findings).toHaveLength(5);
    expect(findings.map((finding) => finding.migrationLevel)).toEqual([
      'CONDITIONAL',
      'CONDITIONAL',
      'CONDITIONAL',
      'MANUAL',
      'MANUAL',
    ]);
    expect(findings.map((finding) => finding.evidence.detail.opacityValue)).toEqual([90, 85, 100, undefined, undefined]);
  });

  it('rewrites alpha-only declarations in a full migration', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const findings = store.listAllFindings(first.id).filter((finding) => finding.ruleId === 'WL-CSS-003');
    expect(findings).toHaveLength(5);
    const convertible = findings.filter((finding) => finding.migrationLevel === 'CONDITIONAL');
    expect(convertible).toHaveLength(3);

    for (const finding of convertible) {
      const plan = service.preview({ scanTaskId: first.id, findingIds: [finding.id] });
      expect(plan.items[0].applicable).toBe(true);
    }
    const result = await service.execute(first.id, convertible.map((finding) => finding.id));
    expect(result.ok).toBe(true);

    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('.amount { opacity: 0.9; }');
    expect(rewritten).toContain('.header { opacity: 0.85 !important; }');
    expect(rewritten).toContain('.full { opacity: 1; }');
    expect(rewritten).toContain('alpha(opacity=50) progid:DXImageTransform.Microsoft.gradient');
    expect(rewritten).toContain('Microsoft.Shadow');

    const second = await scan();
    const remaining = store.listAllFindings(second.id).filter((finding) => finding.ruleId === 'WL-CSS-003');
    expect(remaining).toHaveLength(2);
    expect(remaining.every((finding) => finding.migrationLevel === 'MANUAL')).toBe(true);
  });

  it('refuses to add a second opacity declaration to the same rule', async () => {
    const source = '.panel { opacity: 0.5; filter: alpha(opacity=50); }\n';
    const { store, service, scan } = await setup(source);
    const first = await scan();
    const finding = store.listAllFindings(first.id).find((item) => item.ruleId === 'WL-CSS-003');
    expect(finding?.migrationLevel).toBe('CONDITIONAL');
    const plan = service.preview({ scanTaskId: first.id, findingIds: [finding!.id] });
    expect(plan.items[0].applicable).toBe(false);
    expect(plan.items[0].blockedReasons.join(' ')).toContain('already declares opacity');
  });
});

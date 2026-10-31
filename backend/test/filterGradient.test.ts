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
const SOURCE = `.app-header {
  background: #003366;
  filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#003366', endColorstr='#005599');
}
.horizontal {
  -ms-filter: "progid:DXImageTransform.Microsoft.gradient(gradientType=1, startColorstr='#fff', endColorstr='#000')";
}
.important {
  filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#003366', endColorstr='#005599') !important;
}
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-gradient-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'css'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Filter gradient', root, config);
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

describe('simple IE gradient filter migration', () => {
  it('marks only simple two-color gradients convertible', () => {
    const source = `.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#003366', endColorstr='#005599'); }
.b { -ms-filter: "progid:DXImageTransform.Microsoft.gradient(gradientType=1, startColorstr='#fff', endColorstr='#000')"; }
.c { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#88003366', endColorstr='#005599'); }
.d { filter: alpha(opacity=50) progid:DXImageTransform.Microsoft.gradient(startColorstr='#003366', endColorstr='#005599'); }
.e { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#003366'); }
`;
    const findings = byRule(analyzeText(FILE, source).findings, 'WL-CSS-003');
    expect(findings).toHaveLength(5);
    expect(findings.map((finding) => finding.migrationLevel)).toEqual([
      'CONDITIONAL',
      'CONDITIONAL',
      'MANUAL',
      'MANUAL',
      'MANUAL',
    ]);
    expect(findings[0].evidence.detail.gradientDirection).toBe('to bottom');
    expect(findings[0].evidence.detail.startColor).toBe('#003366');
    expect(findings[1].evidence.detail.gradientDirection).toBe('to right');
    expect(findings[1].evidence.detail.endColor).toBe('#000');
  });

  it('rewrites simple gradients and preserves direction, fallback and !important', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const findings = store
      .listAllFindings(first.id)
      .filter((finding) => finding.ruleId === 'WL-CSS-003');
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.migrationLevel === 'CONDITIONAL')).toBe(true);

    for (const finding of findings) {
      const plan = service.preview({ scanTaskId: first.id, findingIds: [finding.id] });
      expect(plan.items[0].applicable).toBe(true);
    }
    const result = await service.execute(first.id, findings.map((finding) => finding.id));
    expect(result.ok).toBe(true);

    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('background: #003366;');
    expect(rewritten).toContain('background-image: linear-gradient(to bottom, #003366, #005599);');
    expect(rewritten).toContain('background-image: linear-gradient(to right, #fff, #000);');
    expect(rewritten).toContain(
      'background-image: linear-gradient(to bottom, #003366, #005599) !important;',
    );
    expect(rewritten).not.toContain('Microsoft.gradient');

    const second = await scan();
    expect(store.listAllFindings(second.id).filter((finding) => finding.ruleId === 'WL-CSS-003')).toHaveLength(0);
  });

  it('refuses a duplicate background-image or a background shorthand declared after the filter', async () => {
    const source = `.dup { background-image: url(pattern.png); filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#003366', endColorstr='#005599'); }
.late { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#003366', endColorstr='#005599'); background: #fff; }
`;
    const { store, service, scan } = await setup(source);
    const first = await scan();
    const findings = store.listAllFindings(first.id).filter((finding) => finding.ruleId === 'WL-CSS-003');
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      const plan = service.preview({ scanTaskId: first.id, findingIds: [finding.id] });
      expect(plan.items[0].applicable).toBe(false);
    }
    const reasons = findings
      .map((finding) => service.preview({ scanTaskId: first.id, findingIds: [finding.id] }).items[0].blockedReasons.join(' '))
      .join(' ');
    expect(reasons).toContain('already declares background-image');
    expect(reasons).toContain('background shorthand is declared after');
  });
});

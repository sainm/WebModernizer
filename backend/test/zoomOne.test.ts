import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import type { ScanStatus } from '../src/model/types.js';
import { recipeForFinding, ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';
import { analyzeText, byRule } from './helpers.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];
const FILE = 'css/layout.css';
const SOURCE = `.header {
  color: #003366;
  zoom: 1;
}
.important {
  zoom: 1.0 !important;
}
.modal {
  zoom: 1.5;
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-zoom-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'css'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Zoom one', root, config);
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

describe('zoom: 1 hasLayout trigger', () => {
  it('marks only literal 1/1.0 as safe', () => {
    const source = `.a { zoom: 1; }
.b { zoom: 1.0; }
.c { zoom: 1.5; }
.d { zoom: 100%; }
`;
    const analysis = analyzeText(FILE, source);
    const findings = byRule(analysis.findings, 'WL-CSS-006');
    expect(findings.map((finding) => finding.migrationLevel)).toEqual(['SAFE', 'SAFE', 'MANUAL', 'MANUAL']);
    const recipe = recipeForFinding(findings[0]);
    expect(recipe).not.toBeNull();
    expect(recipe!.preconditions(findings[0], { text: source, parsed: analysis.parsed }).ok).toBe(true);
    expect(recipe!.preconditions(findings[2], { text: source, parsed: analysis.parsed }).ok).toBe(false);

    const inline = analyzeText('page.html', '<html><body><div style="zoom: 1;">x</div></body></html>').findings;
    expect(byRule(inline, 'WL-CSS-006')).toHaveLength(1);
    expect(byRule(inline, 'WL-CSS-006')[0].migrationLevel).toBe('MANUAL');
  });

  it('deletes zoom: 1 and preserves the rest of the rule', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const findings = store.listAllFindings(first.id).filter((finding) => finding.ruleId === 'WL-CSS-006');
    expect(findings).toHaveLength(3);
    const convertible = findings.filter((finding) => finding.migrationLevel === 'SAFE');
    expect(convertible).toHaveLength(2);

    for (const finding of convertible) {
      const plan = service.preview({ scanTaskId: first.id, findingIds: [finding.id] });
      expect(plan.items[0].applicable).toBe(true);
    }
    const result = await service.execute(first.id, convertible.map((finding) => finding.id));
    expect(result.ok).toBe(true);

    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('.header {\n  color: #003366;\n}');
    expect(rewritten).toContain('.important {\n}');
    expect(rewritten).toContain('  zoom: 1.5;');
    expect(rewritten).not.toContain('zoom: 1;');
    expect(rewritten).not.toContain('zoom: 1.0');

    const second = await scan();
    const remaining = store.listAllFindings(second.id).filter((finding) => finding.ruleId === 'WL-CSS-006');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].migrationLevel).toBe('MANUAL');
  });
});

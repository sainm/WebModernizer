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
import { RULE_MESSAGES, renderRuleMessage } from '../../web/src/ruleMessages.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];
const FILE = 'js/mouse.js';
const SOURCE = `function onClick(event) {
  if (event.button == 1) {
    return;
  }
}
el.addEventListener('click', onClick);
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-event-button-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Event button', root, config);
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

describe('IE event.button numbering', () => {
  it('marks 1/4 equality comparisons convertible and everything else manual', () => {
    const source = `function onClick(event) {
  if (event.button == 1) { return; }
  if (4 === event.button) { return; }
  if (event.button != 4) { return; }
  if (event.button == 2) { return; }
  if (event.button & 1) { return; }
  var which = event.button;
}`;
    const findings = byRule(analyzeText('r.js', source).findings, 'WL-JS-019');
    expect(findings).toHaveLength(6);
    expect(findings.map((finding) => finding.migrationLevel)).toEqual([
      'CONDITIONAL',
      'CONDITIONAL',
      'CONDITIONAL',
      'MANUAL',
      'MANUAL',
      'MANUAL',
    ]);
    expect(findings.map((finding) => finding.evidence.detail.buttonValue)).toEqual([
      '1',
      '4',
      '4',
      '2',
      '(expression)',
      '(expression)',
    ]);
  });

  it('recognizes the implicit event of an inline handler', () => {
    const source = '<html><body><input type="button" onclick="if (event.button == 4) return;" /></body></html>';
    const findings = byRule(analyzeText('page.html', source).findings, 'WL-JS-019');
    expect(findings).toHaveLength(1);
    expect(findings[0].migrationLevel).toBe('CONDITIONAL');
  });

  it('does not match lookalikes, non-event objects or window.event', () => {
    const cases = [
      'var value = obj.button;',
      'function f(event) { return event.buttonId; }',
      'function f(event) { return event.buttons; }',
      'function f() { return window.event.button; }',
      'function f() { if (custom.button == 1) return; }',
    ];
    for (const source of cases) {
      const findings = analyzeText('r.js', source).findings;
      expect(byRule(findings, 'WL-JS-019'), source).toHaveLength(0);
    }
  });

  it('rewrites the literal in a full migration', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const finding = store.listAllFindings(first.id).find((item) => item.ruleId === 'WL-JS-019');
    expect(finding).toBeDefined();
    expect(finding?.migrationLevel).toBe('CONDITIONAL');

    const plan = service.preview({ scanTaskId: first.id, findingIds: [finding!.id] });
    expect(plan.items[0].applicable).toBe(true);
    const result = await service.execute(first.id, [finding!.id]);
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('if (event.button == 0) {');
  });

  it('renders the button message in both translations', () => {
    const finding = byRule(analyzeText('r.js', SOURCE).findings, 'WL-JS-019')[0];
    expect(finding).toBeDefined();
    for (const locale of ['zh', 'ja'] as const) {
      const template = RULE_MESSAGES[locale][finding.messageKey];
      expect(template).toBeDefined();
      expect(renderRuleMessage(template, finding.messageParams)).toContain('event.button');
    }
  });
});

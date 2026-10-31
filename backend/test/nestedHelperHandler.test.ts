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
const FILE = 'js/handlers.js';
const SOURCE = `function onRowClick() {
  function mark() {
    window.event.cancelBubble = true;
    window.event.returnValue = false;
  }
  mark();
}
el.attachEvent('onclick', onRowClick);
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-nested-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Nested helper', root, config);
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

describe('handler nested helper functions', () => {
  it('offers a handler whose helper is called synchronously from its body', () => {
    const { findings } = analyzeText('r.js', SOURCE);
    const handler = byRule(findings, 'WL-JS-017');
    expect(handler).toHaveLength(1);
    expect(Number(handler[0].evidence.detail.windowEventCount)).toBe(2);
    expect(byRule(findings, 'WL-JS-003')).toHaveLength(0);

    const twoHelpers = analyzeText(
      'r.js',
      [
        'function onRowClick() {',
        '  function stop() { window.event.cancelBubble = true; }',
        '  function cancel() { window.event.returnValue = false; }',
        '  stop();',
        '  cancel();',
        '}',
        "el.attachEvent('onclick', onRowClick);",
      ].join('\n'),
    ).findings;
    expect(byRule(twoHelpers, 'WL-JS-017')).toHaveLength(1);
    expect(Number(byRule(twoHelpers, 'WL-JS-017')[0].evidence.detail.windowEventCount)).toBe(2);
  });

  it('rewrites the handler and its helper, then unlocks the property recipes', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const handler = store.listAllFindings(first.id).find((finding) => finding.ruleId === 'WL-JS-017');
    expect(handler).toBeDefined();

    const plan = service.preview({ scanTaskId: first.id, findingIds: [handler!.id] });
    expect(plan.items[0].applicable).toBe(true);
    const result = await service.execute(first.id, [handler!.id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('function onRowClick(event) {');
    expect(rewritten).toContain('function mark() {');
    expect(rewritten).toContain('event.cancelBubble = true;');
    expect(rewritten).toContain('event.returnValue = false;');
    expect(rewritten).toContain('mark();');
    expect(rewritten.includes('window.event')).toBe(false);

    const second = await scan();
    const remaining = store.listAllFindings(second.id);
    const stop = remaining.find((finding) => finding.ruleId === 'WL-JS-008');
    const prevent = remaining.find((finding) => finding.ruleId === 'WL-JS-007');
    expect(stop?.migrationLevel).toBe('SAFE');
    expect(prevent?.migrationLevel).toBe('CONDITIONAL');

    const properties = await service.execute(second.id, [stop!.id, prevent!.id]);
    expect(properties.ok).toBe(true);
    const finalText = readFileSync(file, 'utf8');
    expect(finalText).toContain('event.stopPropagation();');
    expect(finalText).toContain('event.preventDefault();');
  });

  it('does not offer helpers that escape, wait, shadow event, or are never called', () => {
    const head = 'function onRowClick() {\n';
    const tail = "\n}\nel.attachEvent('onclick', onRowClick);";
    const cases = [
      `${head}  function helper() { window.event.returnValue = false; }\n  return helper;${tail}`,
      `${head}  function helper() { window.event.returnValue = false; }\n  helper();\n  return helper;${tail}`,
      `${head}  function helper() { window.event.returnValue = false; }\n  setTimeout(helper, 0);${tail}`,
      `${head}  function helper() { window.event.returnValue = false; }\n  setTimeout(function () { helper(); }, 0);${tail}`,
      `${head}  function helper(event) { window.event.returnValue = false; }\n  helper();${tail}`,
      `${head}  function helper() { window.event.returnValue = false; }${tail}`,
      `${head}  function helper() { window.event.returnValue = false; }\n  helper.call(null);${tail}`,
      `${head}  async function helper() { window.event.returnValue = false; }\n  helper();${tail}`,
      `${head}  function helper() { function inner() { window.event.returnValue = false; } inner(); }\n  helper();${tail}`,
      `${head}  function safe() { window.event.cancelBubble = true; }\n  function unsafe() { window.event.returnValue = false; }\n  safe();\n  return unsafe;${tail}`,
    ];
    for (const source of cases) {
      const { findings } = analyzeText('r.js', source);
      expect(byRule(findings, 'WL-JS-017'), source).toHaveLength(0);
      expect(byRule(findings, 'WL-JS-003').length, source).toBeGreaterThan(0);
    }
  });
});

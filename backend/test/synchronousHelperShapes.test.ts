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
  const mark = function () {
    window.event.cancelBubble = true;
    window.event.returnValue = false;
  };
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-sync-shapes-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Synchronous helper shapes', root, config);
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

describe('synchronous handler helper shapes', () => {
  it('accepts variable helpers and IIFEs', () => {
    const variable = analyzeText(
      'r.js',
      [
        'function onRowClick() {',
        '  const mark = function () { window.event.cancelBubble = true; };',
        '  mark();',
        '}',
        "el.attachEvent('onclick', onRowClick);",
      ].join('\n'),
    ).findings;
    expect(byRule(variable, 'WL-JS-017')).toHaveLength(1);
    expect(byRule(variable, 'WL-JS-003')).toHaveLength(0);

    const arrow = analyzeText(
      'r.js',
      [
        'function onRowClick() {',
        '  const mark = () => { window.event.returnValue = false; };',
        '  mark();',
        '}',
        "el.attachEvent('onclick', onRowClick);",
      ].join('\n'),
    ).findings;
    expect(byRule(arrow, 'WL-JS-017')).toHaveLength(1);

    const iife = analyzeText(
      'r.js',
      [
        'function onRowClick() {',
        '  (function () { window.event.cancelBubble = true; })();',
        '}',
        "el.attachEvent('onclick', onRowClick);",
      ].join('\n'),
    ).findings;
    expect(byRule(iife, 'WL-JS-017')).toHaveLength(1);
    expect(byRule(iife, 'WL-JS-003')).toHaveLength(0);

    const arrowIife = analyzeText(
      'r.js',
      [
        'function onRowClick() {',
        '  (() => { window.event.returnValue = false; })();',
        '}',
        "el.attachEvent('onclick', onRowClick);",
      ].join('\n'),
    ).findings;
    expect(byRule(arrowIife, 'WL-JS-017')).toHaveLength(1);
  });

  it('rewrites a variable helper and unlocks the property recipes', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const handler = store.listAllFindings(first.id).find((finding) => finding.ruleId === 'WL-JS-017');
    expect(handler).toBeDefined();
    expect(Number(handler?.evidence.detail.windowEventCount)).toBe(2);

    const plan = service.preview({ scanTaskId: first.id, findingIds: [handler!.id] });
    expect(plan.items[0].applicable).toBe(true);
    const result = await service.execute(first.id, [handler!.id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('function onRowClick(event) {');
    expect(rewritten).toContain('const mark = function () {');
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
  });

  it('rejects helpers that escape, wait, reassign, shadow or nest deeper', () => {
    const head = 'function onRowClick() {\n';
    const tail = "\n}\nel.attachEvent('onclick', onRowClick);";
    const cases = [
      `${head}  var mark = function () { window.event.returnValue = false; };\n  return mark;${tail}`,
      `${head}  var mark = function () { window.event.returnValue = false; };\n  setTimeout(mark, 0);${tail}`,
      `${head}  var mark = function () { window.event.returnValue = false; };\n  setTimeout(function () { mark(); }, 0);${tail}`,
      `${head}  var mark = function () { window.event.returnValue = false; };\n  mark = other;\n  mark();${tail}`,
      `${head}  var mark = async function () { window.event.returnValue = false; };\n  mark();${tail}`,
      `${head}  var mark = function () { var event = 1; window.event.returnValue = false; };\n  mark();${tail}`,
      `${head}  var mark = function () { window.event.returnValue = false; };\n  mark.call(null);${tail}`,
      `${head}  setTimeout(function () { (function () { window.event.returnValue = false; })(); }, 0);${tail}`,
      `${head}  (async function () { window.event.returnValue = false; })();${tail}`,
    ];
    for (const source of cases) {
      const findings = analyzeText('r.js', source).findings;
      expect(byRule(findings, 'WL-JS-017'), source).toHaveLength(0);
      expect(byRule(findings, 'WL-JS-003').length, source).toBeGreaterThan(0);
    }
  });

  it('rejects a variable helper that shadows the reused event parameter', () => {
    const source = [
      'function onRowClick(evt) {',
      '  var mark = function () { var evt = 1; window.event.cancelBubble = true; };',
      '  mark();',
      '}',
      "el.addEventListener('click', onRowClick);",
    ].join('\n');
    const findings = analyzeText('r.js', source).findings;
    expect(byRule(findings, 'WL-JS-017')).toHaveLength(0);
  });
});

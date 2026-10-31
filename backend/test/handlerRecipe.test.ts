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
  var cell = window.event.srcElement;
  window.event.cancelBubble = true;
  return cell;
}
document.getElementById('row').attachEvent('onclick', onRowClick);
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

function count(findings: ReturnType<typeof analyzeText>['findings'], ruleId: string): number {
  return byRule(findings, ruleId).length;
}

describe('IE event handler signature rule', () => {
  it('reports one handler finding and takes over the window.event references inside it', () => {
    const { findings } = analyzeText('r.js', SOURCE);
    expect(count(findings, 'WL-JS-017')).toBe(1);
    expect(count(findings, 'WL-JS-003')).toBe(0);
    expect(count(findings, 'WL-JS-006')).toBe(0);
    expect(count(findings, 'WL-JS-008')).toBe(1);
  });

  it('does not offer a handler that is called directly, has a local event binding, nested reference or arguments use', () => {
    const direct = analyzeText(
      'r.js',
      "function onRowClick() { window.event.cancelBubble = true; }\nel.attachEvent('onclick', onRowClick);\nonRowClick();",
    ).findings;
    expect(count(direct, 'WL-JS-017')).toBe(0);
    expect(count(direct, 'WL-JS-003')).toBe(1);

    const local = analyzeText(
      'r.js',
      "function onRowClick() { var event = 1; window.event.cancelBubble = true; }\nel.attachEvent('onclick', onRowClick);",
    ).findings;
    expect(count(local, 'WL-JS-017')).toBe(0);

    const nested = analyzeText(
      'r.js',
      [
        'function onRowClick() {',
        '  var top = window.event.srcElement;',
        '  return function () { return window.event; };',
        '}',
        "el.attachEvent('onclick', onRowClick);",
      ].join('\n'),
    ).findings;
    expect(count(nested, 'WL-JS-017')).toBe(0);
    expect(count(nested, 'WL-JS-003')).toBe(2);

    const args = analyzeText(
      'r.js',
      "function onRowClick() { return arguments.length ? window.event : null; }\nel.attachEvent('onclick', onRowClick);",
    ).findings;
    expect(count(args, 'WL-JS-017')).toBe(0);

    const parameterizedReference = analyzeText(
      'r.js',
      "function onRowClick(sender) { window.event.cancelBubble = true; }\nel.attachEvent('onclick', onRowClick);",
    ).findings;
    expect(count(parameterizedReference, 'WL-JS-017')).toBe(0);
    expect(count(parameterizedReference, 'WL-JS-003')).toBe(1);
  });

  it('does not touch beforeunload handlers or by-reference handlers with existing parameters', () => {
    const unload = analyzeText(
      'r.js',
      'function confirmLeave() { window.event.returnValue = false; }\nwindow.onbeforeunload = confirmLeave;',
    ).findings;
    expect(count(unload, 'WL-JS-017')).toBe(0);
    expect(count(unload, 'WL-JS-003')).toBe(1);

    const parameterized = analyzeText(
      'r.js',
      "function onRowClick(sender) { return window.event; }\nel.attachEvent('onclick', onRowClick);",
    ).findings;
    expect(count(parameterized, 'WL-JS-017')).toBe(0);
  });

  it('detects anonymous functions passed directly or assigned to an on* property', () => {
    const anonymous = analyzeText(
      'r.js',
      "el.attachEvent('onclick', function () { window.event.cancelBubble = true; });",
    ).findings;
    expect(count(anonymous, 'WL-JS-017')).toBe(1);

    const assignment = analyzeText(
      'r.js',
      'function onLoad() { return window.event; }\nwindow.onload = onLoad;',
    ).findings;
    expect(count(assignment, 'WL-JS-017')).toBe(1);
  });
});

describe('handler signature migration', () => {
  it('injects the event parameter, then unlocks the property recipes after a rescan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weblift-handler-'));
    const root = join(dir, 'project');
    mkdirSync(join(root, 'js'), { recursive: true });
    const file = join(root, FILE);
    writeFileSync(file, SOURCE);
    const store = new Store({ dataDir: join(dir, 'data') });
    harnesses.push({ dir, store });
    const config = defaultProjectConfig();
    const project = store.createProject('Handler recipe', root, config);
    const manager = new ScanManager(store, { lockWaitMs: 0 });
    const service = new MigrationService(store, { lockWaitMs: 0 });

    const scan = async () => {
      const task = store.createScan(project, config, ruleSignature());
      manager.start(task.id);
      await waitForScan(store, task.id);
      return task.id;
    };
    const findingIn = (scanId: string, ruleId: string) =>
      store.listAllFindings(scanId).find((item) => item.ruleId === ruleId);

    const first = await scan();
    const handler = findingIn(first, 'WL-JS-017');
    expect(handler).toBeDefined();
    const firstPlan = service.preview({ scanTaskId: first, findingIds: [handler!.id] });
    expect(firstPlan.items[0].applicable).toBe(true);
    expect(firstPlan.items[0].edits.length).toBeGreaterThanOrEqual(2);

    const firstResult = await service.execute(first, [handler!.id]);
    expect(firstResult.ok).toBe(true);
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('function onRowClick(event)');
    expect(rewritten).toContain('event.srcElement');
    expect(rewritten).toContain('event.cancelBubble');
    expect(rewritten.includes('window.event')).toBe(false);

    const second = await scan();
    const srcElement = findingIn(second, 'WL-JS-006');
    const cancelBubble = findingIn(second, 'WL-JS-008');
    expect(srcElement?.migrationLevel).toBe('SAFE');
    expect(cancelBubble?.migrationLevel).toBe('SAFE');
    expect(findingIn(second, 'WL-JS-017')).toBeUndefined();

    const secondPlan = service.preview({ scanTaskId: second, findingIds: [srcElement!.id, cancelBubble!.id] });
    expect(secondPlan.items.every((item) => item.applicable)).toBe(true);
    const secondResult = await service.execute(second, [srcElement!.id, cancelBubble!.id], {
      expectedPlanHash: secondPlan.planHash,
    });
    expect(secondResult.ok).toBe(true);
    const finished = readFileSync(file, 'utf8');
    expect(finished).toContain('event.target');
    expect(finished).toContain('event.stopPropagation()');
    expect(finished.includes('srcElement')).toBe(false);
    expect(finished.includes('cancelBubble')).toBe(false);
  });
});

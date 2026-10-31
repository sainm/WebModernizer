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
const FILE = 'js/handlers.js';
const SOURCE = `function onRowClick(evt) {
  window.event.cancelBubble = true;
  return evt;
}
el.addEventListener('click', onRowClick);
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-reuse-param-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  const file = join(root, FILE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Reuse parameter', root, config);
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

describe('existing event parameter on an event-first registration', () => {
  it('reuses the first parameter without changing the signature', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const handler = store.listAllFindings(first.id).find((finding) => finding.ruleId === 'WL-JS-017');
    expect(handler).toBeDefined();
    expect(handler?.messageKey).toBe('rules.WL-JS-017.reuse');
    expect(handler?.evidence.detail.eventParam).toBe('evt');
    expect(Number(handler?.evidence.detail.paramCount)).toBe(1);
    expect(store.listAllFindings(first.id).filter((finding) => finding.ruleId === 'WL-JS-003')).toHaveLength(0);

    const plan = service.preview({ scanTaskId: first.id, findingIds: [handler!.id] });
    expect(plan.items[0].applicable).toBe(true);
    const result = await service.execute(first.id, [handler!.id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('function onRowClick(evt) {');
    expect(rewritten).toContain('evt.cancelBubble = true;');
    expect(rewritten).toContain('return evt;');
    expect(rewritten.includes('window.event')).toBe(false);

    const second = await scan();
    const stop = store.listAllFindings(second.id).find((finding) => finding.ruleId === 'WL-JS-008');
    expect(stop?.migrationLevel).toBe('SAFE');
    const properties = await service.execute(second.id, [stop!.id]);
    expect(properties.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('evt.stopPropagation();');
  });

  it('reuses a sender parameter on an on* property registration', async () => {
    const source = `function onLoad(sender) {
  window.event.returnValue = false;
  return sender;
}
window.onload = onLoad;
`;
    const { findings } = analyzeText('r.js', source);
    const handler = byRule(findings, 'WL-JS-017');
    expect(handler).toHaveLength(1);
    expect(handler[0].evidence.detail.eventParam).toBe('sender');

    const { file, store, service, scan } = await setup(source);
    const first = await scan();
    const stored = store.listAllFindings(first.id).find((finding) => finding.ruleId === 'WL-JS-017');
    const result = await service.execute(first.id, [stored!.id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('function onLoad(sender) {');
    expect(rewritten).toContain('sender.returnValue = false;');

    const second = await scan();
    const prevent = store.listAllFindings(second.id).find((finding) => finding.ruleId === 'WL-JS-007');
    expect(prevent?.migrationLevel).toBe('CONDITIONAL');
  });

  it('reuses an anonymous handler parameter and a nested helper', () => {
    const anonymous = analyzeText(
      'r.js',
      "el.addEventListener('click', function (evt) { window.event.cancelBubble = true; });",
    ).findings;
    expect(byRule(anonymous, 'WL-JS-017')).toHaveLength(1);
    expect(byRule(anonymous, 'WL-JS-017')[0].evidence.detail.eventParam).toBe('evt');

    const nested = analyzeText(
      'r.js',
      [
        'function onRowClick(evt) {',
        '  function mark() { window.event.cancelBubble = true; }',
        '  mark();',
        '}',
        "el.addEventListener('click', onRowClick);",
      ].join('\n'),
    ).findings;
    expect(byRule(nested, 'WL-JS-017')).toHaveLength(1);
    expect(byRule(nested, 'WL-JS-017')[0].evidence.detail.eventParam).toBe('evt');
    expect(byRule(nested, 'WL-JS-003')).toHaveLength(0);
  });

  it('does not reuse a parameter when the registration or call shape is ambiguous', () => {
    const cases = [
      "function onRowClick(sender) { window.event.returnValue = false; }\nel.attachEvent('onclick', onRowClick);",
      "function onRowClick(evt) { window.event.returnValue = false; }\nel.addEventListener('click', onRowClick);\nonRowClick(null);",
      "function onRowClick(evt) { window.event.returnValue = false; }\nel.addEventListener('click', onRowClick);\nel.attachEvent('onclick', onRowClick);",
      "function onRowClick(event) { window.event.returnValue = false; }\nel.addEventListener('click', onRowClick);",
      "function onRowClick({ value }) { window.event.returnValue = false; }\nel.addEventListener('click', onRowClick);",
      "function onRowClick(evt) { return arguments.length ? window.event : null; }\nel.addEventListener('click', onRowClick);",
      "function onRowClick(evt) { var event = 1; window.event.returnValue = false; }\nel.addEventListener('click', onRowClick);",
      "function onRowClick(evt) { function mark() { var evt = 1; window.event.returnValue = false; } mark(); }\nel.addEventListener('click', onRowClick);",
    ];
    for (const source of cases) {
      const { findings } = analyzeText('r.js', source);
      expect(byRule(findings, 'WL-JS-017'), source).toHaveLength(0);
      expect(byRule(findings, 'WL-JS-003').length, source).toBeGreaterThan(0);
    }

    const inlineAndReference = analyzeText(
      'page.html',
      [
        '<html><body>',
        '<input id="row" onclick="onRowClick()" />',
        '<script type="text/javascript">',
        'function onRowClick(evt) { window.event.returnValue = false; }',
        "document.getElementById('row').addEventListener('click', onRowClick);",
        '</script></body></html>',
      ].join('\n'),
    ).findings;
    expect(byRule(inlineAndReference, 'WL-JS-017')).toHaveLength(0);
  });

  it('renders the reuse message in both translations', () => {
    const { findings } = analyzeText('r.js', SOURCE);
    const finding = byRule(findings, 'WL-JS-017')[0];
    expect(finding).toBeDefined();
    for (const locale of ['zh', 'ja'] as const) {
      const template = RULE_MESSAGES[locale][finding.messageKey];
      expect(template).toBeDefined();
      const rendered = renderRuleMessage(template, finding.messageParams);
      expect(rendered).toContain('evt');
    }
  });
});

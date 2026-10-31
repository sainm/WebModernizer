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
const PAGE = 'page.html';
const SOURCE = `<html><body>
<input type="button" id="update" onclick="window.event.cancelBubble = true; window.event.returnValue = false;" />
</body></html>
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-inline-attr-'));
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  const file = join(root, PAGE);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Inline attribute', root, config);
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

describe('inline handler attribute window.event', () => {
  it('reports one finding per attribute and covers its window.event references', () => {
    const { findings } = analyzeText(PAGE, SOURCE);
    const inline = byRule(findings, 'WL-JS-018');
    expect(inline).toHaveLength(1);
    expect(inline[0].migrationLevel).toBe('CONDITIONAL');
    expect(Number(inline[0].evidence.detail.windowEventCount)).toBe(2);
    expect(inline[0].evidence.detail.attribute).toBe('click');
    expect(byRule(findings, 'WL-JS-003')).toHaveLength(0);
    expect(byRule(findings, 'WL-JS-007')[0]?.migrationLevel).toBe('MANUAL');
    expect(byRule(findings, 'WL-JS-008')[0]?.migrationLevel).toBe('MANUAL');
  });

  it('rewrites the attribute and unlocks the property recipes after a rescan', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const inline = store.listAllFindings(first.id).find((finding) => finding.ruleId === 'WL-JS-018');
    expect(inline).toBeDefined();

    const plan = service.preview({ scanTaskId: first.id, findingIds: [inline!.id] });
    expect(plan.items[0].applicable).toBe(true);
    const result = await service.execute(first.id, [inline!.id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('onclick="event.cancelBubble = true; event.returnValue = false;"');
    expect(rewritten.includes('window.event')).toBe(false);

    const second = await scan();
    const remaining = store.listAllFindings(second.id);
    expect(remaining.filter((finding) => finding.ruleId === 'WL-JS-018')).toHaveLength(0);
    expect(remaining.filter((finding) => finding.ruleId === 'WL-JS-003')).toHaveLength(0);
    const stop = remaining.find((finding) => finding.ruleId === 'WL-JS-008');
    const prevent = remaining.find((finding) => finding.ruleId === 'WL-JS-007');
    expect(stop?.migrationLevel).toBe('SAFE');
    expect(prevent?.migrationLevel).toBe('CONDITIONAL');

    const properties = await service.execute(second.id, [stop!.id, prevent!.id]);
    expect(properties.ok).toBe(true);
    const finalText = readFileSync(file, 'utf8');
    expect(finalText).toContain('onclick="event.stopPropagation(); event.preventDefault();"');
  });

  it('leaves nested functions, shadowed event bindings, writes, probes and script blocks alone', () => {
    const cases = [
      `<html><body><input type="button" onclick="window.event.returnValue = false; setTimeout(function () { window.event.returnValue = false; }, 0);" /></body></html>`,
      `<html><body><input type="button" onclick="var event = 1; window.event.returnValue = false;" /></body></html>`,
      `<html><body><input type="button" onclick="window.event = null;" /></body></html>`,
      `<html><body><input type="button" onclick="if (typeof window.event === 'undefined') return;" /></body></html>`,
      '<html><body><script type="text/javascript">window.event.returnValue = false;</script></body></html>',
    ];
    for (const source of cases) {
      const { findings } = analyzeText(PAGE, source);
      expect(byRule(findings, 'WL-JS-018'), source).toHaveLength(0);
    }
    const nested = analyzeText(PAGE, cases[0]).findings;
    expect(byRule(nested, 'WL-JS-003')).toHaveLength(2);
    const shadowed = analyzeText(PAGE, cases[1]).findings;
    expect(byRule(shadowed, 'WL-JS-003')).toHaveLength(1);
    const script = analyzeText(PAGE, cases[4]).findings;
    expect(byRule(script, 'WL-JS-003')).toHaveLength(1);
  });

  it('does not offer unload attributes', () => {
    const source = '<html><body><img src="a.gif" onunload="window.event.returnValue = false;" /></body></html>';
    const { findings } = analyzeText(PAGE, source);
    expect(byRule(findings, 'WL-JS-018')).toHaveLength(0);
    expect(byRule(findings, 'WL-JS-003')).toHaveLength(1);
  });

  it('renders the inline attribute message in both translations', () => {
    const source = '<html><body><input type="button" onclick="window.event.returnValue = false;" /></body></html>';
    const { findings } = analyzeText(PAGE, source);
    const finding = byRule(findings, 'WL-JS-018')[0];
    expect(finding).toBeDefined();
    for (const locale of ['zh', 'ja'] as const) {
      const template = RULE_MESSAGES[locale][finding.messageKey];
      expect(template).toBeDefined();
      const rendered = renderRuleMessage(template, finding.messageParams);
      expect(rendered).toContain('click');
    }
  });
});

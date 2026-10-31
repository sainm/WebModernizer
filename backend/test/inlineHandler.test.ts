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
const JSP = 'page.jsp';
const SOURCE = `<html><body>
<input type="button" id="update" onclick="onUpdateClick()" />
<script type="text/javascript">
function onUpdateClick() {
  window.event.returnValue = false;
}
</script>
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-inline-'));
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  const file = join(root, JSP);
  writeFileSync(file, source);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Inline handler', root, config);
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

function findingIn(store: Store, scanId: string, ruleId: string) {
  return store.listAllFindings(scanId).find((finding) => finding.ruleId === ruleId);
}

describe('inline handler call migration', () => {
  it('rewrites the function signature, window.event and the inline call in one plan', async () => {
    const { file, store, service, scan } = await setup(SOURCE);
    const first = await scan();
    const handler = findingIn(store, first.id, 'WL-JS-017');
    expect(handler).toBeDefined();
    expect(handler?.messageKey).toBe('rules.WL-JS-017.inline');
    expect(Number(handler?.evidence.detail?.inlineCallCount)).toBe(1);
    expect(byRule(store.listAllFindings(first.id), 'WL-JS-003')).toHaveLength(0);

    const plan = service.preview({ scanTaskId: first.id, findingIds: [handler!.id] });
    expect(plan.items[0].applicable).toBe(true);
    expect(plan.items[0].edits).toHaveLength(3);

    const result = await service.execute(first.id, [handler!.id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('function onUpdateClick(event)');
    expect(rewritten).toContain('onclick="onUpdateClick(event)"');
    expect(rewritten).toContain('event.returnValue');
    expect(rewritten.includes('window.event')).toBe(false);

    const second = await scan();
    expect(findingIn(store, second.id, 'WL-JS-017')).toBeUndefined();
    const returnValue = findingIn(store, second.id, 'WL-JS-007');
    expect(returnValue?.migrationLevel).toBe('CONDITIONAL');
    const secondPlan = service.preview({ scanTaskId: second.id, findingIds: [returnValue!.id] });
    expect(secondPlan.items[0].applicable).toBe(true);
    await service.execute(second.id, [returnValue!.id], { expectedPlanHash: secondPlan.planHash });
    expect(readFileSync(file, 'utf8')).toContain('event.preventDefault()');
  });

  it('does not offer a handler that is also called outside an inline handler', async () => {
    const source = SOURCE.replace('</script>', 'onUpdateClick();\n</script>');
    const { findings } = analyzeText(JSP, source);
    expect(byRule(findings, 'WL-JS-017')).toHaveLength(0);
    expect(byRule(findings, 'WL-JS-003')).toHaveLength(1);
  });

  it('keeps existing parameters while adding event first', async () => {
    const source = `<html><body>
<input type="button" id="update" onclick="onUpdateClick(this)" />
<script type="text/javascript">
function onUpdateClick(sender) {
  window.event.returnValue = false;
  return sender;
}
</script>
</body></html>
`;
    const { file, store, service, scan } = await setup(source);
    const first = await scan();
    const handler = findingIn(store, first.id, 'WL-JS-017');
    expect(handler).toBeDefined();
    expect(Number(handler?.evidence.detail?.paramCount)).toBe(1);

    const plan = service.preview({ scanTaskId: first.id, findingIds: [handler!.id] });
    expect(plan.items[0].applicable).toBe(true);
    const result = await service.execute(first.id, [handler!.id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('function onUpdateClick(event, sender)');
    expect(rewritten).toContain('onclick="onUpdateClick(event, this)"');
    expect(rewritten).toContain('event.returnValue');
    expect(rewritten).toContain('return sender');
    expect(rewritten.includes('window.event')).toBe(false);
  });

  it('does not offer a handler that already binds event', () => {
    const source = `<html><body>
<input type="button" id="update" onclick="onUpdateClick(this)" />
<script type="text/javascript">
function onUpdateClick(event) {
  window.event.returnValue = false;
}
</script>
</body></html>
`;
    const { findings } = analyzeText(JSP, source);
    expect(byRule(findings, 'WL-JS-017')).toHaveLength(0);
  });

  it('renders the inline message in both translations', async () => {
    const { store, scan } = await setup(SOURCE);
    const first = await scan();
    const handler = findingIn(store, first.id, 'WL-JS-017');
    for (const locale of ['zh', 'ja'] as const) {
      const template = RULE_MESSAGES[locale][handler!.messageKey];
      expect(template).toBeDefined();
      const rendered = renderRuleMessage(template, handler!.messageParams);
      expect(rendered).toContain('onUpdateClick');
      expect(rendered).toContain('1');
    }
  });
});

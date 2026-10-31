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
import { RULE_MESSAGES, renderRuleMessage } from '../../web/src/ruleMessages.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];
const SHARED = 'js/shared.js';
const PAGE = 'page.jsp';
const SHARED_SOURCE = `function sharedRowClick() {
  var cell = window.event.srcElement;
  window.event.cancelBubble = true;
  return cell;
}
`;
const PAGE_SOURCE = `<html><body>
<input type="button" id="row" onclick="sharedRowClick()" />
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

async function setup(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-crossinline-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Cross-file inline', root, config);
  const manager = new ScanManager(store, { lockWaitMs: 0 });
  const service = new MigrationService(store, { lockWaitMs: 0 });
  const scan = async () => {
    const task = store.createScan(project, config, ruleSignature());
    manager.start(task.id);
    await waitForScan(store, task.id);
    return store.getScan(task.id)!;
  };
  return { root, store, service, scan };
}

function findingsIn(store: Store, scanId: string, filePath: string) {
  return store.listAllFindings(scanId).filter((finding) => finding.filePath === filePath);
}

describe('cross-file inline handler calls', () => {
  it('expands the definition and every inline call into one plan and applies them atomically', async () => {
    const { root, store, service, scan } = await setup({ [SHARED]: SHARED_SOURCE, [PAGE]: PAGE_SOURCE });
    const first = await scan();
    const definition = findingsIn(store, first.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-017');
    const callSite = findingsIn(store, first.id, PAGE).find((finding) => finding.ruleId === 'WL-JS-017');
    expect(definition).toBeDefined();
    expect(callSite).toBeDefined();
    expect(definition?.messageKey).toBe('rules.WL-JS-017.inlineCalls');
    expect(callSite?.messageKey).toBe('rules.WL-JS-017.inlineCallSite');
    expect(String(definition?.evidence.detail?.companionFindingIds)).toContain(callSite!.id);
    expect(String(callSite?.evidence.detail?.companionFindingIds)).toContain(definition!.id);
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-003')).toHaveLength(0);

    const fromDefinition = service.preview({ scanTaskId: first.id, findingIds: [definition!.id] });
    expect(fromDefinition.items).toHaveLength(2);
    expect(fromDefinition.items.every((item) => item.applicable)).toBe(true);
    expect(new Set(fromDefinition.items.map((item) => item.filePath))).toEqual(new Set([SHARED, PAGE]));

    const fromCallSite = service.preview({ scanTaskId: first.id, findingIds: [callSite!.id] });
    expect(fromCallSite.items).toHaveLength(2);
    expect(new Set(fromCallSite.items.map((item) => item.filePath))).toEqual(new Set([SHARED, PAGE]));

    const result = await service.execute(first.id, [definition!.id]);
    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(2);
    const shared = readFileSync(join(root, SHARED), 'utf8');
    const page = readFileSync(join(root, PAGE), 'utf8');
    expect(shared).toContain('function sharedRowClick(event)');
    expect(shared).toContain('event.srcElement');
    expect(shared.includes('window.event')).toBe(false);
    expect(page).toContain('onclick="sharedRowClick(event)"');

    const second = await scan();
    expect(findingsIn(store, second.id, SHARED).some((finding) => finding.ruleId === 'WL-JS-017')).toBe(false);
    expect(findingsIn(store, second.id, PAGE).some((finding) => finding.ruleId === 'WL-JS-017')).toBe(false);
    const srcElement = findingsIn(store, second.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-006');
    const cancelBubble = findingsIn(store, second.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-008');
    expect(srcElement?.migrationLevel).toBe('SAFE');
    expect(cancelBubble?.migrationLevel).toBe('SAFE');
    expect(
      service.preview({ scanTaskId: second.id, findingIds: [srcElement!.id] }).items[0].applicable,
    ).toBe(true);
  });

  it('blocks the group when the same function is called outside an inline handler', async () => {
    const page = PAGE_SOURCE.replace('</body>', '<script>sharedRowClick();</script></body>');
    const { store, scan } = await setup({ [SHARED]: SHARED_SOURCE, [PAGE]: page });
    const first = await scan();
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-017')).toHaveLength(0);
    expect(findingsIn(store, first.id, PAGE).filter((finding) => finding.ruleId === 'WL-JS-017')).toHaveLength(0);
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-003')).toHaveLength(2);
  });

  it('keeps existing parameters while passing event first across files', async () => {
    const shared = `function sharedRowClick(sender) {
  var cell = window.event.srcElement;
  return sender;
}
`;
    const page = PAGE_SOURCE.replace('sharedRowClick()', 'sharedRowClick(this)');
    const { root, store, service, scan } = await setup({ [SHARED]: shared, [PAGE]: page });
    const first = await scan();
    const definition = findingsIn(store, first.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-017');
    const callSite = findingsIn(store, first.id, PAGE).find((finding) => finding.ruleId === 'WL-JS-017');
    expect(definition).toBeDefined();
    expect(callSite).toBeDefined();
    expect(Number(definition?.evidence.detail?.paramCount)).toBe(1);

    const plan = service.preview({ scanTaskId: first.id, findingIds: [definition!.id] });
    expect(plan.items).toHaveLength(2);
    expect(plan.items.every((item) => item.applicable)).toBe(true);
    const result = await service.execute(first.id, [definition!.id]);
    expect(result.ok).toBe(true);
    const sharedAfter = readFileSync(join(root, SHARED), 'utf8');
    const pageAfter = readFileSync(join(root, PAGE), 'utf8');
    expect(sharedAfter).toContain('function sharedRowClick(event, sender)');
    expect(sharedAfter).toContain('event.srcElement');
    expect(sharedAfter).toContain('return sender');
    expect(sharedAfter.includes('window.event')).toBe(false);
    expect(pageAfter).toContain('onclick="sharedRowClick(event, this)"');
  });

  it('aborts the whole plan when an inline call site changed after the scan', async () => {
    const { root, store, service, scan } = await setup({ [SHARED]: SHARED_SOURCE, [PAGE]: PAGE_SOURCE });
    const first = await scan();
    const definition = findingsIn(store, first.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-017');
    writeFileSync(join(root, PAGE), PAGE_SOURCE.replace('</body>', '<!-- edited --></body>'));
    const sharedBefore = readFileSync(join(root, SHARED), 'utf8');

    const plan = service.preview({ scanTaskId: first.id, findingIds: [definition!.id] });
    expect(plan.items.some((item) => item.filePath === PAGE && item.staleFile)).toBe(true);
    const result = await service.execute(first.id, [definition!.id], { expectedPlanHash: plan.planHash });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(readFileSync(join(root, SHARED), 'utf8')).toBe(sharedBefore);
  });

  it('renders both cross-file inline message variants', async () => {
    const { store, scan } = await setup({ [SHARED]: SHARED_SOURCE, [PAGE]: PAGE_SOURCE });
    const first = await scan();
    const findings = store.listAllFindings(first.id).filter((finding) => finding.ruleId === 'WL-JS-017');
    for (const finding of findings) {
      for (const locale of ['zh', 'ja'] as const) {
        const template = RULE_MESSAGES[locale][finding.messageKey];
        expect(template).toBeDefined();
        const rendered = renderRuleMessage(template, finding.messageParams);
        expect(rendered).not.toBeNull();
      }
    }
  });
});

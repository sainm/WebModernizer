import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import type { ScanStatus, ScanTask } from '../src/model/types.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';
import { RULE_MESSAGES, renderRuleMessage } from '../../web/src/ruleMessages.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];
const SHARED = 'js/shared.js';
const PAGE = 'js/page.js';
const SHARED_SOURCE = `function sharedRowClick() {
  var cell = window.event.srcElement;
  window.event.cancelBubble = true;
  return cell;
}
`;
const PAGE_SOURCE = "document.getElementById('row').attachEvent('onclick', sharedRowClick);\n";

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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-cross-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'js'), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const config = defaultProjectConfig();
  const project = store.createProject('Cross-file handler', root, config);
  const manager = new ScanManager(store, { lockWaitMs: 0 });
  const service = new MigrationService(store, { lockWaitMs: 0 });
  const scan = async (): Promise<ScanTask> => {
    const task = store.createScan(project, config, ruleSignature());
    manager.start(task.id);
    await waitForScan(store, task.id);
    return store.getScan(task.id) as ScanTask;
  };
  return { root, store, service, scan };
}

function findingsIn(store: Store, scanId: string, filePath: string) {
  return store.listAllFindings(scanId).filter((finding) => finding.filePath === filePath);
}

describe('cross-file handler migration', () => {
  it('offers a cross-file handler, suppresses its covered references, and unlocks the property recipes', async () => {
    const { root, store, service, scan } = await setup({ [SHARED]: SHARED_SOURCE, [PAGE]: PAGE_SOURCE });
    const first = await scan();
    const handler = findingsIn(store, first.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-017');
    expect(handler).toBeDefined();
    expect(handler?.messageKey).toBe('rules.WL-JS-017.crossFile');
    expect(handler?.migrationLevel).toBe('CONDITIONAL');
    expect(String(handler?.evidence.detail?.registrationFile)).toBe(PAGE);
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-003')).toHaveLength(0);

    for (const file of store.listScanFiles(first.id)) {
      expect(file.findingCount, file.path).toBe(findingsIn(store, first.id, file.path).length);
    }

    const plan = service.preview({ scanTaskId: first.id, findingIds: [handler!.id] });
    expect(plan.items[0].applicable).toBe(true);
    const result = await service.execute(first.id, [handler!.id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(join(root, SHARED), 'utf8');
    expect(rewritten).toContain('function sharedRowClick(event)');
    expect(rewritten).toContain('event.srcElement');
    expect(rewritten.includes('window.event')).toBe(false);
    expect(readFileSync(join(root, PAGE), 'utf8')).toBe(PAGE_SOURCE);

    const second = await scan();
    expect(findingsIn(store, second.id, SHARED).some((finding) => finding.ruleId === 'WL-JS-017')).toBe(false);
    const srcElement = findingsIn(store, second.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-006');
    const cancelBubble = findingsIn(store, second.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-008');
    expect(srcElement?.migrationLevel).toBe('SAFE');
    expect(cancelBubble?.migrationLevel).toBe('SAFE');

    const secondPlan = service.preview({ scanTaskId: second.id, findingIds: [srcElement!.id, cancelBubble!.id] });
    expect(secondPlan.items.every((item) => item.applicable)).toBe(true);
    const secondResult = await service.execute(second.id, [srcElement!.id, cancelBubble!.id], {
      expectedPlanHash: secondPlan.planHash,
    });
    expect(secondResult.ok).toBe(true);
    const finished = readFileSync(join(root, SHARED), 'utf8');
    expect(finished).toContain('event.target');
    expect(finished).toContain('event.stopPropagation()');
  });

  it('rewrites a synchronous helper in a cross-file definition', async () => {
    const shared = `function sharedRowClick() {
  function mark() { window.event.cancelBubble = true; }
  mark();
}
`;
    const { root, store, service, scan } = await setup({ [SHARED]: shared, [PAGE]: PAGE_SOURCE });
    const first = await scan();
    const handlers = findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-017');
    expect(handlers).toHaveLength(1);
    expect(Number(handlers[0].evidence.detail.windowEventCount)).toBe(1);
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-003')).toHaveLength(0);

    const plan = service.preview({ scanTaskId: first.id, findingIds: [handlers[0].id] });
    expect(plan.items[0].applicable).toBe(true);
    const result = await service.execute(first.id, [handlers[0].id]);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(join(root, SHARED), 'utf8');
    expect(rewritten).toContain('function sharedRowClick(event)');
    expect(rewritten).toContain('event.cancelBubble = true;');
    expect(rewritten.includes('window.event')).toBe(false);
  });

  it('does not offer a handler with parameters that is registered by reference', async () => {
    const shared = `function sharedRowClick(sender) {
  var cell = window.event.srcElement;
  return cell;
}
`;
    const { store, scan } = await setup({ [SHARED]: shared, [PAGE]: PAGE_SOURCE });
    const first = await scan();
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-017')).toHaveLength(0);
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-003')).toHaveLength(1);
  });

  it('does not offer a cross-file handler that is called directly', async () => {
    const page = `${PAGE_SOURCE}sharedRowClick();\n`;
    const { store, scan } = await setup({ [SHARED]: SHARED_SOURCE, [PAGE]: page });
    const first = await scan();
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-017')).toHaveLength(0);
    expect(findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-003')).toHaveLength(2);
  });

  it('does not duplicate a handler that is registered in its own file', async () => {
    const shared = `${SHARED_SOURCE}document.getElementById('row').attachEvent('onclick', sharedRowClick);\n`;
    const { store, scan } = await setup({ [SHARED]: shared });
    const first = await scan();
    const handlers = findingsIn(store, first.id, SHARED).filter((finding) => finding.ruleId === 'WL-JS-017');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].messageKey).toBe('rules.WL-JS-017');
  });

  it('blocks the migration when the registration file changed after the scan', async () => {
    const { root, store, service, scan } = await setup({ [SHARED]: SHARED_SOURCE, [PAGE]: PAGE_SOURCE });
    const first = await scan();
    const handler = findingsIn(store, first.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-017');
    writeFileSync(join(root, PAGE), `${PAGE_SOURCE}// reviewed later\n`);

    const plan = service.preview({ scanTaskId: first.id, findingIds: [handler!.id] });
    expect(plan.items[0].applicable).toBe(false);
    expect(plan.items[0].blockedReasons.join(' ')).toContain('Registration file js/page.js changed');
  });

  it('renders the cross-file message in both translations', async () => {
    const { store, scan } = await setup({ [SHARED]: SHARED_SOURCE, [PAGE]: PAGE_SOURCE });
    const first = await scan();
    const handler = findingsIn(store, first.id, SHARED).find((finding) => finding.ruleId === 'WL-JS-017');
    for (const locale of ['zh', 'ja'] as const) {
      const template = RULE_MESSAGES[locale][handler!.messageKey];
      expect(template).toBeDefined();
      const rendered = renderRuleMessage(template, handler!.messageParams);
      expect(rendered).toContain('sharedRowClick');
      expect(rendered).toContain(PAGE);
    }
  });
});

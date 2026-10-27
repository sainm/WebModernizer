import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { buildSummary } from '../src/core/report.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { ValidationService } from '../src/core/validation.js';
import { Store } from '../src/storage/store.js';
import type { ScanStatus } from '../src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '../../examples/legacy-app');
const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

async function waitForScan(store: Store, scanId: string, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const scan = store.getScan(scanId);
    if (scan && TERMINAL.includes(scan.status)) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('scan did not finish in time');
}

describe('end-to-end scan of the legacy example project', () => {
  let workDir: string;
  let projectCopy: string;
  let store: Store;
  let scanId: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'weblift-it-'));
    projectCopy = join(workDir, 'legacy-app');
    cpSync(exampleRoot, projectCopy, { recursive: true });
    store = new Store({ dataDir: join(workDir, 'data') });
    const scans = new ScanManager(store);
    const project = store.createProject('Legacy Orders', projectCopy, defaultProjectConfig());
    const scan = store.createScan(project, defaultProjectConfig());
    scanId = scan.id;
    scans.start(scan.id);
    await waitForScan(store, scan.id);
  }, 60000);

  afterAll(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('scans every source file in the project', () => {
    const scan = store.getScan(scanId);
    expect(scan?.status).toBe('COMPLETED');
    const files = store.listScanFiles(scanId);
    expect(files.length).toBe(12);
    expect(files.every((file) => file.parseStatus === 'PARSED')).toBe(true);
  });

  it('records the real encoding per file', () => {
    const files = store.listScanFiles(scanId);
    const sjis = files.find((file) => file.path === 'js/shift-jis-helper.js');
    expect(sjis?.encoding).toBe('shift_jis');
  });

  it('produces findings with precise locations', () => {
    const summary = buildSummary(store, scanId);
    expect(summary.totals.findings).toBeGreaterThan(80);
    expect(summary.totals.highRisk).toBeGreaterThan(30);
    expect(summary.totals.autoConvertible).toBeGreaterThan(0);
    expect(summary.totals.unsupported).toBeGreaterThan(0);

    const { items } = store.listFindings(scanId, { limit: 2000 });
    for (const finding of items.slice(0, 40)) {
      expect(finding.startLine).toBeGreaterThan(0);
      expect(finding.startColumn).toBeGreaterThan(0);
      expect(finding.filePath.length).toBeGreaterThan(0);
      expect(finding.evidence.matched.length).toBeGreaterThan(0);
    }
  });

  it('never reports decoy text from comments or string literals', () => {
    const all = store.listAllFindings(scanId);
    const decoys = all.filter((finding) => /attachEvent is deprecated/.test(finding.snippet));
    expect(decoys).toHaveLength(0);

    // The real call inside index.jsp is still reported, at the right line.
    const real = all.find((finding) => finding.filePath === 'index.jsp' && finding.ruleId === 'WL-JS-001');
    const lines = readFileSync(join(projectCopy, 'index.jsp'), 'utf8').split('\n');
    expect(lines[real!.startLine - 1]).toContain('attachEvent');
  });

  it('reports zero findings in the modern JavaScript file', () => {
    const all = store.listAllFindings(scanId);
    expect(all.filter((finding) => finding.filePath === 'js/modern.js')).toHaveLength(0);
  });

  it('builds confirmed and unknown file relations', () => {
    const relations = store.listRelations(scanId);
    const confirmed = relations.find(
      (rel) => rel.fromPath === 'index.jsp' && rel.toPath === 'js/common.js' && rel.confidence === 'CONFIRMED',
    );
    expect(confirmed).toBeDefined();
    expect(confirmed?.kind).toBe('SCRIPT_SRC');

    const stylesheet = relations.find((rel) => rel.fromPath === 'index.jsp' && rel.toPath === 'css/main.css');
    expect(stylesheet?.kind).toBe('STYLESHEET');

    // detail.jsp builds the script URL from a JSP expression: the edge must not be CONFIRMED.
    const dynamic = relations.find(
      (rel) => rel.fromPath === 'order/detail.jsp' && rel.toPath === 'js/common.js' && rel.kind === 'SCRIPT_SRC',
    );
    expect(dynamic?.confidence).toBe('UNKNOWN');

    // The same file also calls a function defined in common.js, which is a separate,
    // symbol-based edge and must stay INFERRED rather than being merged with the URL edge.
    const inferred = relations.find(
      (rel) => rel.fromPath === 'order/detail.jsp' && rel.toPath === 'js/common.js' && rel.kind === 'SHARED_FUNCTION_CALL',
    );
    expect(inferred?.confidence).toBe('INFERRED');
  });

  it('previews an event-handler migration without touching the file', () => {
    const before = readFileSync(join(projectCopy, 'js/legacy-events.js'), 'utf8');
    const all = store.listAllFindings(scanId);
    const target = all.find((finding) => finding.filePath === 'js/legacy-events.js' && finding.ruleId === 'WL-JS-001');
    expect(target).toBeDefined();

    const service = new MigrationService(store);
    const plan = service.preview({ scanTaskId: scanId, findingIds: [target!.id] });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].applicable).toBe(true);
    expect(plan.items[0].unifiedDiff).toContain('addEventListener');
    expect(plan.items[0].unifiedDiff).toContain('"mouseover"');
    expect(plan.items[0].unifiedDiff).not.toContain('attachEvent("mouseover"');
    expect(readFileSync(join(projectCopy, 'js/legacy-events.js'), 'utf8')).toBe(before);
  });

  it('executes the migration, validates it and rolls it back', () => {
    const all = store.listAllFindings(scanId);
    const target = all.find((finding) => finding.filePath === 'js/legacy-events.js' && finding.ruleId === 'WL-JS-001')!;
    const original = readFileSync(join(projectCopy, 'js/legacy-events.js'), 'utf8');
    const service = new MigrationService(store);

    const result = service.execute(scanId, [target.id]);
    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(1);

    const migrated = readFileSync(join(projectCopy, 'js/legacy-events.js'), 'utf8');
    expect(migrated).toContain('attachEvent');
    expect(migrated.split('attachEvent').length).toBe(original.split('attachEvent').length - 1);
    expect(migrated).toContain('addEventListener("mouseover", onRowOver)');
    expect(existsSync(result.executions[0].backupPath)).toBe(true);

    const updated = store.getFinding(target.id);
    expect(updated?.status).toBe('MIGRATED');

    const validation = new ValidationService(store).validateStatic(scanId, ['js/legacy-events.js']);
    expect(validation.findingsChecked).toBeGreaterThanOrEqual(1);
    expect(validation.findingsStillPresent).toBe(0);
    expect(validation.passed).toBe(true);

    const rollback = service.rollback(result.executions[0].id);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(join(projectCopy, 'js/legacy-events.js'), 'utf8')).toBe(original);
    expect(store.getMigration(result.executions[0].id)?.executionStatus).toBe('ROLLED_BACK');
  });

  it('refuses to migrate when the file changed after the scan', () => {
    const all = store.listAllFindings(scanId);
    const target = all.find((finding) => finding.filePath === 'js/dynamic-loader.js' && finding.ruleId === 'WL-BEH-001');
    const service = new MigrationService(store);
    if (!target) {
      // dynamic-loader.js has no UA strings in the current fixture: pick any file and inject noise.
      const fallback = all.find((finding) => finding.filePath === 'js/legacy-events.js' && finding.ruleId === 'WL-JS-002')!;
      writeFileSync(join(projectCopy, 'js/legacy-events.js'), `${readFileSync(join(projectCopy, 'js/legacy-events.js'), 'utf8')}\n// changed\n`);
      const plan = service.preview({ scanTaskId: scanId, findingIds: [fallback.id] });
      expect(plan.items[0].applicable).toBe(false);
      expect(plan.items[0].blockedReasons.join(' ')).toMatch(/changed/i);
      return;
    }
    const file = join(projectCopy, 'js/dynamic-loader.js');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// changed after scan\n`);
    const plan = service.preview({ scanTaskId: scanId, findingIds: [target.id] });
    expect(plan.items[0].applicable).toBe(false);
  });
});

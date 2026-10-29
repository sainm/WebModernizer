import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { Store } from '../src/storage/store.js';
import type { ScanStatus } from '../src/model/types.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

// Shift_JIS bytes: the match is pure ASCII, the comment after it is not. This is the shape that
// used to be "migrated" successfully while destroying the comment.
const SJIS_SOURCE =
  'function boot() {\r\n' +
  "  document.getElementById('row').attachEvent('onclick', handler);\r\n" +
  '  // \x93\xfa\x96{\x8c\xea\x82\xcc\x83R\x83\x81\x83\x93\x83g\r\n' +
  '}\r\n';

const PLAIN_SOURCE = `function boot() {
  document.getElementById('row').attachEvent('onclick', handler);
  // 日本語のコメント
}
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
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('scan did not finish in time');
}

async function setup(files: Record<string, { bytes: Buffer; mode?: number }>) {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-enc-'));
  const projectDir = join(dir, 'project');
  mkdirSync(join(projectDir, 'js'), { recursive: true });
  for (const [name, spec] of Object.entries(files)) {
    const target = join(projectDir, name);
    writeFileSync(target, spec.bytes);
    if (spec.mode !== undefined) chmodSync(target, spec.mode);
  }

  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });
  const scans = new ScanManager(store);
  const config = defaultProjectConfig();
  const project = store.createProject('Encoding Test', projectDir, config);
  const scan = store.createScan(project, config);
  scans.start(scan.id);
  await waitForScan(store, scan.id);

  const service = new MigrationService(store);
  const findingFor = (filePath: string) => {
    const finding = store.listAllFindings(scan.id).find((item) => item.filePath === filePath);
    if (!finding) throw new Error(`no finding in ${filePath}`);
    return finding;
  };
  return { dir, projectDir, store, scanId: scan.id, service, findingFor };
}

describe('encoding safety of migrations', () => {
  it('refuses to rewrite a file it cannot encode back, and leaves the bytes alone', async () => {
    const target = 'js/sjis.js';
    const { projectDir, service, scanId, store, findingFor } = await setup({
      [target]: { bytes: Buffer.from(SJIS_SOURCE, 'latin1') },
    });
    const file = join(projectDir, target);
    const before = readFileSync(file);

    // The scan read it correctly, so the finding exists and is a real migration candidate.
    expect(store.getScanFile(scanId, target)?.encoding).toBe('shift_jis');
    const finding = findingFor(target);
    expect(['SAFE', 'CONDITIONAL']).toContain(finding.migrationLevel);

    const plan = service.preview({ scanTaskId: scanId, findingIds: [finding.id] });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].applicable).toBe(false);
    expect(plan.items[0].blockedReasons.join(' ')).toContain('shift_jis');
    expect(plan.items[0].blockedReasons.join(' ')).toMatch(/UTF-8/);

    const result = await service.execute(scanId, [finding.id]);
    expect(result.ok).toBe(false);
    expect(result.executions).toHaveLength(0);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readFileSync(file).includes(Buffer.from([0x93, 0xfa, 0x96, 0x7b]))).toBe(true);
  });

  it('keeps the byte-order mark and the surrounding text when migrating a UTF-8 file', async () => {
    const target = 'js/bom.js';
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PLAIN_SOURCE, 'utf8')]);
    const { projectDir, service, scanId, findingFor } = await setup({ [target]: { bytes: original } });
    const file = join(projectDir, target);

    const finding = findingFor(target);
    const result = await service.execute(scanId, [finding.id]);
    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(1);

    const after = readFileSync(file);
    expect(after.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = after.subarray(3).toString('utf8');
    expect(text).toContain("addEventListener('click', handler)");
    expect(text).toContain('日本語のコメント');
    expect(text.includes('\uFFFD')).toBe(false);
  });

  it('preserves file permissions across the atomic write', async () => {
    const target = 'js/locked.js';
    const { projectDir, service, scanId, findingFor } = await setup({
      // 0777 rather than an unremarkable mode: the temp file is created under the process
      // umask, so a mode the umask would strip is what makes the restoration observable.
      [target]: { bytes: Buffer.from(PLAIN_SOURCE, 'utf8'), mode: 0o777 },
    });
    const file = join(projectDir, target);
    expect(statSync(file).mode & 0o777).toBe(0o777);

    const finding = findingFor(target);
    const result = await service.execute(scanId, [finding.id]);
    expect(result.ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o777);
  });
});

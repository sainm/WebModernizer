import Encoding from 'encoding-japanese';
import iconv from 'iconv-lite';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { canEncodeEncoding, encodeText } from '../src/core/textDecode.js';
import { sha256 } from '../src/model/ids.js';
import type { ProjectConfig, ScanStatus } from '../src/model/types.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

const SOURCE = [
  'function boot() {',
  "  document.getElementById('row').attachEvent('onclick', handler);",
  '  // 日本語のコメント',
  '}',
  '',
].join('\r\n');

const UTF8_SOURCE = `function boot() {
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

async function setup(
  files: Record<string, { bytes: Buffer; mode?: number }>,
  configOverrides: Partial<ProjectConfig> = {},
) {
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
  const config = { ...defaultProjectConfig(), ...configOverrides };
  const project = store.createProject('Encoding Test', projectDir, config);
  const scan = store.createScan(project, config, ruleSignature());
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

function encodeFixture(encoding: string, text: string): Buffer {
  if (encoding === 'iso-2022-jp') {
    return Buffer.from(Encoding.convert(text, { to: 'JIS', from: 'UNICODE', type: 'array', fallback: 'error' }));
  }
  if (encoding === 'shift_jis') return iconv.encode(text, 'cp932');
  if (encoding === 'euc-jp') return iconv.encode(text, 'euc-jp');
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf16-le')]);
  if (encoding === 'utf-16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf16-be')]);
  return Buffer.from(text, 'utf8');
}

const DECLARED_CASES = [
  { label: 'Shift_JIS', encoding: 'shift_jis', text: SOURCE, bomLength: 0 },
  { label: 'EUC-JP', encoding: 'euc-jp', text: '// <meta charset="euc-jp">\r\n' + SOURCE, bomLength: 0 },
  {
    label: 'ISO-2022-JP',
    encoding: 'iso-2022-jp',
    text: '// <meta charset="iso-2022-jp">\r\n' + SOURCE,
    bomLength: 0,
  },
  { label: 'UTF-16LE', encoding: 'utf-16le', text: SOURCE, bomLength: 2 },
  { label: 'UTF-16BE', encoding: 'utf-16be', text: SOURCE, bomLength: 2 },
] as const;

describe('encoding-safe migrations', () => {
  for (const testCase of DECLARED_CASES) {
    it(`migrates a ${testCase.label} file and writes it back in the same encoding`, async () => {
      const target = 'js/legacy.js';
      const bytes = encodeFixture(testCase.encoding, testCase.text);
      const { projectDir, service, scanId, store, findingFor } = await setup({ [target]: { bytes } });
      const file = join(projectDir, target);
      const before = readFileSync(file);

      expect(store.getScanFile(scanId, target)?.encoding).toBe(testCase.encoding);
      const finding = findingFor(target);
      expect(['SAFE', 'CONDITIONAL']).toContain(finding.migrationLevel);

      const plan = service.preview({ scanTaskId: scanId, findingIds: [finding.id] });
      expect(plan.items).toHaveLength(1);
      expect(plan.items[0].encoding).toBe(testCase.encoding);
      expect(plan.items[0].applicable).toBe(true);

      const result = await service.execute(scanId, [finding.id], { expectedPlanHash: plan.planHash });
      expect(result.ok).toBe(true);
      expect(result.executions).toHaveLength(1);

      const after = readFileSync(file);
      expect(after.subarray(0, testCase.bomLength)).toEqual(before.subarray(0, testCase.bomLength));
      const body = after.subarray(testCase.bomLength);
      const decoded = new TextDecoder(testCase.encoding, { fatal: true }).decode(body);
      const expectedAfter = testCase.text.replace("attachEvent('onclick'", "addEventListener('click'");
      expect(decoded).toBe(expectedAfter);
      expect(decoded).toContain('日本語のコメント');
      expect(decoded).not.toContain('\uFFFD');
      expect(decoded.replace(/\r\n/g, '')).not.toContain('\n');

      expect(result.executions[0].afterHash).toBe(sha256(after));

      const rollback = await service.rollbackSession(result.sessionId);
      expect(rollback.ok).toBe(true);
      expect(readFileSync(file).equals(before)).toBe(true);
    });
  }

  it('refuses an edit the source encoding cannot represent', () => {
    const result = encodeText('const smile = "😀";', 'shift_jis');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('shift_jis');
      expect(result.reason).toContain('U+1F600');
    }

    const ascii = encodeText('plain ascii', 'shift_jis');
    expect(ascii.ok).toBe(true);
    expect(canEncodeEncoding('iso-2022-jp')).toBe(true);
    expect(canEncodeEncoding('x-user-defined')).toBe(false);
  });

  it('blocks a file whose encoding has no encoder, and leaves the bytes alone', async () => {
    const target = 'js/exotic.js';
    // x-mac-cyrillic is decodable by this runtime but has no iconv-lite encoder, which is exactly
    // the case the guard exists for. (x-user-defined cannot be used here: the runtime cannot
    // decode it at all, so the scan never produces a finding to block.)
    const bytes = encodeFixture('shift_jis', SOURCE);
    const { projectDir, service, scanId, store, findingFor } = await setup(
      { [target]: { bytes } },
      { forceEncoding: 'x-mac-cyrillic' },
    );
    const file = join(projectDir, target);
    expect(store.getScanFile(scanId, target)?.encoding).toBe('x-mac-cyrillic');

    const finding = findingFor(target);
    const plan = service.preview({ scanTaskId: scanId, findingIds: [finding.id] });
    expect(plan.items[0].encoding).toBe('x-mac-cyrillic');
    expect(plan.items[0].applicable).toBe(false);
    expect(plan.items[0].blockedReasons.join(' ')).toContain('no encoder');

    const result = await service.execute(scanId, [finding.id]);
    expect(result.ok).toBe(false);
    expect(result.executions).toHaveLength(0);
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it('fails the whole scan when the forced encoding cannot be decoded at all', async () => {
    const { store, scanId } = await setup({ 'js/a.js': { bytes: Buffer.from(SOURCE, 'utf8') } }, {
      forceEncoding: 'x-user-defined',
    });

    const scan = store.getScan(scanId);
    expect(scan?.status).toBe('FAILED');
    // The message has to name the setting, not the files: "cannot read file" would send the user
    // looking at a source tree that is perfectly fine.
    expect(scan?.errorSummary).toContain('forceEncoding');
    expect(scan?.errorSummary).toContain('x-user-defined');
    expect(store.listScanFiles(scanId)).toHaveLength(0);
  });

  it('keeps the byte-order mark and the surrounding text when migrating a UTF-8 file', async () => {
    const target = 'js/bom.js';
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(UTF8_SOURCE, 'utf8')]);
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
      [target]: { bytes: Buffer.from(UTF8_SOURCE, 'utf8'), mode: 0o777 },
    });
    const file = join(projectDir, target);
    expect(statSync(file).mode & 0o777).toBe(0o777);

    const finding = findingFor(target);
    const result = await service.execute(scanId, [finding.id]);
    expect(result.ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o777);
  });
});

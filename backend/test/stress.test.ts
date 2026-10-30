import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateStressProject } from '../../scripts/gen-stress-project.mjs';
import { ScanManager } from '../src/core/orchestrator.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';
import type { ScanStatus } from '../src/model/types.js';

/**
 * Regression guard for the defects the hostile corpus exposed.
 *
 * The 12-file fixture is too well behaved to show them: every include fragment is a document
 * there, and every label happens to be English.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

describe('hostile corpus', () => {
  let workDir: string;
  let projectDir: string;
  let store: Store;
  let scanId: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'weblift-stress-'));
    projectDir = join(workDir, 'stress');
    // Six modules is enough to exercise the fragment path without slowing the suite down.
    generateStressProject(projectDir, 6);

    store = new Store({ dataDir: join(workDir, 'data') });
    const scans = new ScanManager(store);
    const project = store.createProject('Stress', projectDir, defaultProjectConfig());
    const scan = store.createScan(project, defaultProjectConfig(), ruleSignature());
    scanId = scan.id;
    scans.start(scan.id);

    const started = Date.now();
    while (Date.now() - started < 60000) {
      const current = store.getScan(scan.id);
      if (current && TERMINAL.includes(current.status)) break;
      await new Promise((done) => setTimeout(done, 50));
    }
  }, 90000);

  afterAll(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('scans every hostile file without a hard failure', () => {
    const scan = store.getScan(scanId);
    expect(scan?.status).toBe('COMPLETED');
    expect(scan?.failedFileCount).toBe(0);

    const problems = store.listParseProblems(scanId);
    const hard = problems.filter((problem) => !problem.recovered);
    expect(hard.map((problem) => `${problem.filePath}: ${problem.message}`)).toEqual([]);
  });

  it('does not report include fragments as missing a doctype', () => {
    // A .jspf is a fragment by definition; claiming it lacks a doctype buried 40 real
    // problems under 44 fake ones on the first stress run.
    const problems = store.listParseProblems(scanId);
    const fragmentNoise = problems.filter((problem) => problem.filePath.endsWith('.jspf') && /doctype/i.test(problem.message));
    expect(fragmentNoise).toEqual([]);
  });

  it('detects and decodes the hand-encoded Shift_JIS file', () => {
    const files = store.listScanFiles(scanId);
    const sjis = files.find((file) => file.path === 'js/hand-encoded-sjis.js');
    expect(sjis?.encoding).toBe('shift_jis');
    expect(sjis?.parseStatus).toBe('PARSED');

    const finding = store.listFindingsForFile(scanId, 'js/hand-encoded-sjis.js')[0];
    expect(finding?.ruleId).toBe('WL-JS-001');
    expect(finding?.startLine).toBe(3);
    expect(finding?.startColumn).toBe(3);
    expect(finding?.snippet).toContain('attachEvent');
  });

  it('parses minified, BOM and CRLF sources without problems', () => {
    const problems = store.listParseProblems(scanId);
    for (const path of ['js/minified-legacy.js', 'js/bom-file.js', 'js/crlf-legacy.js', 'js/deep-nesting.js']) {
      expect(problems.filter((problem) => problem.filePath === path)).toEqual([]);
    }
    const minified = store.listFindingsForFile(scanId, 'js/minified-legacy.js');
    expect(minified.length).toBeGreaterThanOrEqual(3);
  });

  it('recovers from malformed HTML and still locates findings in it', () => {
    const files = store.listScanFiles(scanId);
    const broken = files.find((file) => file.path === 'static/broken.html');
    expect(broken?.parseStatus).toBe('PARSED');
    expect(broken?.findingCount).toBeGreaterThan(0);
  });

  it('produces findings that all carry a plausible location', () => {
    const findings = store.listAllFindings(scanId);
    expect(findings.length).toBeGreaterThan(50);
    for (const finding of findings) {
      expect(finding.startLine).toBeGreaterThan(0);
      expect(finding.startColumn).toBeGreaterThan(0);
      expect(finding.snippet.length).toBeGreaterThan(0);
      expect(finding.evidence.matched.length).toBeGreaterThan(0);
    }
  });
});

describe('backend text is English', () => {
  const HAN = /\p{Script=Han}/u;

  function collect(dir: string, files: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full, files);
      else if (full.endsWith('.ts')) files.push(full);
    }
    return files;
  }

  it('contains no Chinese in source strings or comments', () => {
    // The UI translates its own labels; backend text is English so the report and the API
    // never mix languages. A stray label here is invisible until an English report shows it.
    const offenders: string[] = [];
    for (const file of collect(resolve(here, '../src'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (HAN.test(line)) offenders.push(`${file.replace(resolve(here, '../src'), 'src')}:${index + 1}: ${line.trim().slice(0, 60)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

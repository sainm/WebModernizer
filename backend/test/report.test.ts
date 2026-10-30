import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
import { buildSummary, reportAsHtml, reportAsJson } from '../src/core/report.js';
import { defaultProjectConfig } from '../src/core/scanner.js';
import { ruleSignature } from '../src/recipes/registry.js';
import { Store } from '../src/storage/store.js';
import type { ScanStatus } from '../src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '../../examples/legacy-app');
const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

function makePng(width: number, height: number, painter: (x: number, y: number) => [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = painter(x, y);
      const index = (width * y + x) * 4;
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

const white = (): [number, number, number, number] => [255, 255, 255, 255];

const harnesses: Array<{ dir: string; store: Store }> = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-report-'));
  const projectDir = join(dir, 'legacy-app');
  cpSync(exampleRoot, projectDir, { recursive: true });
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });

  const scans = new ScanManager(store);
  const project = store.createProject('Report Test', projectDir, defaultProjectConfig());
  const scan = store.createScan(project, defaultProjectConfig(), ruleSignature());
  scans.start(scan.id);

  const started = Date.now();
  while (Date.now() - started < 30000) {
    const current = store.getScan(scan.id);
    if (current && TERMINAL.includes(current.status)) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  return { store, scanId: scan.id };
}

describe('report content', () => {
  it('says plainly when nothing was migrated', async () => {
    const { store, scanId } = await setup();
    const html = reportAsHtml(store, scanId);
    expect(html).toContain('Migrations applied (0)');
    expect(html).toContain('No migration was applied for this scan.');
    expect(html).toContain('Verification runs (0)');
  });

  it('lists migrations and the visual comparison behind them', async () => {
    const { store, scanId } = await setup();
    const finding = store.listAllFindings(scanId).find((item) => item.migrationLevel === 'SAFE');
    expect(finding).toBeDefined();

    let call = 0;
    await new MigrationService(store).execute(scanId, [finding!.id], {
      visual: {
        pages: [{ pageKey: 'orders', url: 'http://localhost:9999/orders' }],
        capture: async () => {
          call += 1;
          const png = call === 1 ? makePng(20, 20, white) : makePng(20, 20, (x, y) => (x === 3 && y === 7 ? [0, 0, 0, 255] : white()));
          return { png, width: 20, height: 20 };
        },
      },
    });

    const html = reportAsHtml(store, scanId);
    expect(html).toContain('Migrations applied (1)');
    expect(html).toContain(finding!.filePath);
    expect(html).toContain(finding!.ruleId);
    expect(html).toContain('APPLIED');
    expect(html).toContain('Verification runs (1)');
    expect(html).toContain('VISUAL_MIGRATION');
    expect(html).toContain('orders');
    expect(html).toContain('http://localhost:9999/orders');
    // 1 changed pixel out of 400.
    expect(html).toContain('0.25%');

    const payload = JSON.parse(reportAsJson(store, scanId)) as {
      migrations: Array<{ ruleId: string; filePath: string }>;
      validations: Array<{ scope: string; passed: boolean; payload: { results?: Array<{ pageKey: string; changedPixels: number }> } }>;
    };
    expect(payload.migrations).toHaveLength(1);
    expect(payload.migrations[0].ruleId).toBe(finding!.ruleId);
    expect(payload.validations).toHaveLength(1);
    expect(payload.validations[0].scope).toBe('VISUAL_MIGRATION');
    expect(payload.validations[0].passed).toBe(false);
    expect(payload.validations[0].payload.results?.[0]).toMatchObject({ pageKey: 'orders', changedPixels: 1 });
  });

  it('keeps image data out of the archived report', async () => {
    const { store, scanId } = await setup();
    const finding = store.listAllFindings(scanId).find((item) => item.migrationLevel === 'SAFE')!;
    await new MigrationService(store).execute(scanId, [finding.id], {
      visual: {
        pages: [{ pageKey: 'orders', url: 'http://localhost:9999/orders' }],
        capture: async () => ({ png: makePng(10, 10, white), width: 10, height: 10 }),
      },
    });

    const json = reportAsJson(store, scanId);
    // Data URLs would balloon the report; the UI links to them instead.
    expect(json).not.toContain('data:image/png;base64');
  });
});

describe('module grouping', () => {
  it('groups findings by the configured modules, not by directory guesswork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weblift-module-'));
    const projectDir = join(dir, 'legacy-app');
    cpSync(exampleRoot, projectDir, { recursive: true });
    const store = new Store({ dataDir: join(dir, 'data') });
    harnesses.push({ dir, store });

    const config = defaultProjectConfig();
    config.modules = [
      { name: 'styles', path: 'css' },
      { name: 'scripts', path: 'js' },
      { name: 'pages', path: '.' },
    ];

    const scans = new ScanManager(store);
    const project = store.createProject('Modules', projectDir, config);
    const scan = store.createScan(project, config, ruleSignature());
    scans.start(scan.id);
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const current = store.getScan(scan.id);
      if (current && TERMINAL.includes(current.status)) break;
      await new Promise((done) => setTimeout(done, 50));
    }

    const summary = buildSummary(store, scan.id);
    const byModule = new Map(summary.byModule.map((row) => [row.module, row.count]));

    // CSS files land in `styles`, JS files in `scripts`, everything else in `pages`.
    expect(byModule.get('styles')).toBeGreaterThan(0);
    expect(byModule.get('scripts')).toBeGreaterThan(0);
    expect(byModule.get('pages')).toBeGreaterThan(0);
    expect(summary.byModule.reduce((total, row) => total + row.count, 0)).toBe(summary.totals.findings);
    expect(summary.byModule[0].count).toBeGreaterThanOrEqual(summary.byModule[summary.byModule.length - 1].count);
  });
});

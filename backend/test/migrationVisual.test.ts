import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { MigrationService } from '../src/core/migration.js';
import { ScanManager } from '../src/core/orchestrator.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'weblift-visual-mig-'));
  const projectDir = join(dir, 'legacy-app');
  cpSync(exampleRoot, projectDir, { recursive: true });
  const store = new Store({ dataDir: join(dir, 'data') });
  harnesses.push({ dir, store });

  const scans = new ScanManager(store);
  const project = store.createProject('Visual Migration', projectDir, defaultProjectConfig());
  const scan = store.createScan(project, defaultProjectConfig(), ruleSignature());
  scans.start(scan.id);

  const started = Date.now();
  while (Date.now() - started < 30000) {
    const current = store.getScan(scan.id);
    if (current && TERMINAL.includes(current.status)) break;
    await new Promise((done) => setTimeout(done, 50));
  }

  const service = new MigrationService(store);
  const finding = store.listAllFindings(scan.id).find((item) => item.migrationLevel === 'SAFE');
  if (!finding) throw new Error('fixture has no SAFE finding');
  return { store, service, scanId: scan.id, findingId: finding.id };
}

function visualRunCount(store: Store): number {
  const row = store.db.prepare("SELECT COUNT(*) AS c FROM validation_run WHERE scope = 'VISUAL_MIGRATION'").get() as
    | { c: number }
    | undefined;
  return row?.c ?? 0;
}

describe('visual comparison around a migration', () => {
  it('captures before and after, reports the diff and records the run', async () => {
    const { store, service, scanId, findingId } = await setup();
    let call = 0;
    const capture = async () => {
      call += 1;
      // Second call includes one dark pixel: a real (small) visual change.
      const png = call === 1 ? makePng(40, 30, white) : makePng(40, 30, (x, y) => (x === 5 && y === 5 ? [0, 0, 0, 255] : white()));
      return { png, width: 40, height: 30 };
    };

    const result = await service.execute(scanId, [findingId], {
      visual: { pages: [{ pageKey: 'index', url: 'http://localhost:9999/' }], capture },
    });

    expect(result.ok).toBe(true);
    expect(call).toBe(2);
    expect(result.visual).toHaveLength(1);
    expect(result.visual[0].captured).toBe(true);
    expect(result.visual[0].changedPixels).toBe(1);
    expect(result.visual[0].diffPercent).toBeGreaterThan(0);
    expect(result.visual[0].beforeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.visual[0].afterDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.warnings.join(' ')).toMatch(/changed visually/);
    expect(visualRunCount(store)).toBe(1);
  });

  it('reports an unchanged page as zero without warning', async () => {
    const { store, service, scanId, findingId } = await setup();
    const capture = async () => ({ png: makePng(40, 30, white), width: 40, height: 30 });

    const result = await service.execute(scanId, [findingId], {
      visual: { pages: [{ pageKey: 'index', url: 'http://localhost:9999/' }], capture },
    });

    expect(result.visual[0].changedPixels).toBe(0);
    expect(result.visual[0].diffPercent).toBe(0);
    expect(result.warnings.join(' ')).not.toMatch(/changed visually/);
    expect(visualRunCount(store)).toBe(1);
  });

  it('never fails the migration when the page cannot be captured', async () => {
    const { store, service, scanId, findingId } = await setup();
    const capture = async () => null;

    const result = await service.execute(scanId, [findingId], {
      visual: { pages: [{ pageKey: 'index', url: 'http://localhost:9999/' }], capture },
    });

    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(1);
    expect(result.visual[0].captured).toBe(false);
    expect(result.visual[0].reason).toMatch(/could not be captured/);
  });

  it('skips the comparison entirely when no pages are given', async () => {
    const { service, scanId, findingId } = await setup();
    const result = await service.execute(scanId, [findingId]);
    expect(result.ok).toBe(true);
    expect(result.visual).toEqual([]);
  });
});

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeParsedFile } from '../analysis/engine.js';
import { RECIPE_RULE_IDS } from '../recipes/registry.js';
import type {
  AnalysisFinding,
  BrowserValidationResult,
  ValidationReport,
  VisualValidationResult,
} from '../model/types.js';
import { sha256 } from '../model/ids.js';
import { makeSourceFile, parseSourceFile } from '../parser/index.js';
import type { Store } from '../storage/store.js';
import { resolveProjectPath } from './scanner.js';
import { comparePngs, pngDimensions, toDataUrl } from './imageDiff.js';
import { dataRoot } from './report.js';

/** Minimal structural types for the optional Playwright dependency. */
interface BrowserInstance {
  newPage(options?: Record<string, unknown>): Promise<{
    evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
    locator(selector: string): unknown;
    waitForLoadState(state: 'load' | 'networkidle', options?: Record<string, unknown>): Promise<void>;
    screenshot(options?: Record<string, unknown>): Promise<Buffer>;
    on(event: 'console', handler: (message: BrowserConsoleMessage) => void): void;
    on(event: 'pageerror', handler: (error: Error) => void): void;
    on(event: 'requestfailed', handler: (request: BrowserRequest) => void): void;
    goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  }>;
  close(): Promise<void>;
}

interface BrowserConsoleMessage {
  type(): string;
  text(): string;
}

interface BrowserRequest {
  url(): string;
  failure(): { errorText?: string } | null;
}

/**
 * Optional browser override. Air-gapped installs and pinned-browser environments
 * need to point at a specific Chromium build instead of Playwright's managed one.
 */
function launchOptions(): Record<string, unknown> {
  const executablePath = process.env.WEBLIFT_CHROMIUM_PATH;
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

export class ValidationService {
  constructor(private readonly store: Store) {}

  /**
   * Static validation: re-parse and re-analyze the touched files, then compare with
   * what the scan recorded. A migration passes only when the targeted findings are
   * gone and no new hard syntax error appeared.
   */
  validateStatic(scanTaskId: string, filePaths?: string[]): ValidationReport {
    const scan = this.store.getScan(scanTaskId);
    if (!scan) throw new Error(`Unknown scan ${scanTaskId}`);

    const executions = this.store.listMigrations(scanTaskId).filter((item) => item.executionStatus === 'APPLIED');
    const targets = filePaths?.length ? filePaths : [...new Set(executions.map((item) => item.filePath))];
    const notes: string[] = [];
    const newSyntaxErrors: ValidationReport['newSyntaxErrors'] = [];
    const postConditionFailures: string[] = [];

    let checked = 0;
    let resolved = 0;
    let stillPresent = 0;

    const disabledRules = new Set<string>();
    for (const [ruleId, enabled] of this.store.listRuleStates()) {
      if (!enabled) disabledRules.add(ruleId);
    }

    for (const filePath of targets) {
      const absPath = resolveProjectPath(scan.rootPath, filePath);
      if (!absPath || !existsSync(absPath)) {
        notes.push(`${filePath}: file no longer exists, cannot validate.`);
        continue;
      }
      const buffer = readFileSync(absPath);
      const text = buffer.toString('utf8');
      const parsed = parseSourceFile(makeSourceFile(scan.rootPath, filePath, absPath, text));
      const current: AnalysisFinding[] = analyzeParsedFile(parsed, {
        scanTaskId,
        disabledRuleIds: disabledRules,
        recipeRuleIds: RECIPE_RULE_IDS,
      });

      for (const problem of parsed.problems) {
        if (!problem.recovered) newSyntaxErrors.push(problem);
      }

      const fileExecutions = executions.filter((item) => item.filePath === filePath);
      const baseline = this.store.listAllFindings(scanTaskId).filter((finding) => finding.filePath === filePath);

      // One file usually holds several findings of the same rule (three attachEvent
      // calls, for instance). Validation therefore compares per-rule counts instead of
      // asking "does this rule still appear anywhere in the file".
      const byRule = new Map<string, typeof fileExecutions>();
      for (const execution of fileExecutions) {
        const group = byRule.get(execution.ruleId) ?? [];
        group.push(execution);
        byRule.set(execution.ruleId, group);
      }

      for (const [ruleId, group] of byRule) {
        const beforeCount = baseline.filter((finding) => finding.ruleId === ruleId).length;
        const afterCount = current.filter((finding) => finding.ruleId === ruleId).length;
        const expectedAfter = Math.max(0, beforeCount - group.length);

        for (const execution of group) {
          checked += 1;
          if (afterCount <= expectedAfter && afterCount < beforeCount) {
            resolved += 1;
            this.store.updateMigration(execution.id, { validationStatus: 'PASSED' });
            this.store.updateFindingStatus(
              execution.findingId,
              'VALIDATED',
              'system:validation',
              'Static re-analysis no longer reports this occurrence',
            );
          } else {
            stillPresent += 1;
            this.store.updateMigration(execution.id, { validationStatus: 'FAILED' });
            this.store.updateFindingStatus(
              execution.findingId,
              'VALIDATION_FAILED',
              'system:validation',
              `Static re-analysis still reports ${ruleId} (${afterCount} remaining, expected at most ${expectedAfter})`,
            );
            postConditionFailures.push(
              `${filePath}: ${ruleId} still reported ${afterCount} time(s) after migrating ${group.length} occurrence(s).`,
            );
          }
        }
      }

      const currentHash = sha256(buffer);
      const scanned = this.store.getScanFile(scanTaskId, filePath);
      if (scanned && scanned.hash !== currentHash) {
        notes.push(`${filePath}: content differs from the scan snapshot; findings outside the migrated range may be stale.`);
      }
    }

    const passed = checked > 0 && stillPresent === 0 && newSyntaxErrors.length === 0;
    if (checked === 0) notes.push('No applied migrations were found for this scan.');

    const report: ValidationReport = {
      scanTaskId,
      executedAt: new Date().toISOString(),
      scope: 'STATIC',
      findingsChecked: checked,
      findingsResolved: resolved,
      findingsStillPresent: stillPresent,
      newSyntaxErrors,
      postConditionFailures,
      passed,
      notes,
    };
    this.store.insertValidationRun(scanTaskId, 'STATIC', passed, {});
    return report;
  }

  /**
   * Optional Chrome validation through Playwright. Phase one keeps this strictly
   * optional: when the dependency is absent the caller gets an explicit
   * "unavailable" result rather than a failing scan.
   */
  async validateBrowser(options: { scanTaskId: string; url: string; timeoutMs?: number }): Promise<ValidationReport> {
    const scan = this.store.getScan(options.scanTaskId);
    if (!scan) throw new Error(`Unknown scan ${options.scanTaskId}`);

    const browser = await this.runBrowserCheck(options.url, options.timeoutMs ?? 20000);
    const passed = browser.available && browser.pageLoaded === true && browser.consoleErrors.length === 0;
    const report: ValidationReport = {
      scanTaskId: options.scanTaskId,
      executedAt: new Date().toISOString(),
      scope: 'BROWSER',
      findingsChecked: 0,
      findingsResolved: 0,
      findingsStillPresent: 0,
      newSyntaxErrors: [],
      postConditionFailures: [],
      browser,
      passed,
      notes: browser.available
        ? ['Browser validation only covers page load and console errors for the given URL; it is not a functional regression test.']
        : [browser.reason ?? 'Browser validation unavailable.'],
    };
    this.store.insertValidationRun(options.scanTaskId, 'BROWSER', passed, { browser });
    return report;
  }

  /**
   * Visual regression check: capture the page, compare it against the stored baseline
   * for this page key, and report the share of differing pixels. The first capture for
   * a page becomes the baseline instead of pretending to be a "pass".
   */
  /**
   * Visual check for one page at one viewport. Kept as the single-viewport entry point
   * (used by scripts and the earlier UI) while `validateVisualMatrix` loops over it.
   */
  async validateVisual(options: {
    scanTaskId: string;
    url: string;
    pageKey: string;
    updateBaseline?: boolean;
    width?: number;
    height?: number;
    timeoutMs?: number;
    maskSelectors?: string[];
  }): Promise<VisualValidationResult> {
    const scan = this.store.getScan(options.scanTaskId);
    if (!scan) throw new Error(`Unknown scan ${options.scanTaskId}`);
    return this.runVisualCheck({
      scan,
      url: options.url,
      baselineKey: options.pageKey,
      label: options.pageKey,
      width: options.width ?? 1280,
      height: options.height ?? 900,
      timeoutMs: options.timeoutMs ?? 20000,
      maskSelectors: options.maskSelectors ?? [],
      updateBaseline: Boolean(options.updateBaseline),
    });
  }

  /**
   * One screenshot with no baseline involved. Used by the migration flow, which compares
   * the page against itself captured moments earlier rather than against stored history.
   */
  async captureScreenshot(
    url: string,
    width = 1280,
    height = 900,
    maskSelectors: string[] = [],
  ): Promise<{ png: Buffer; width: number; height: number } | null> {
    const capture = await this.capturePage(url, width, height, 20000, maskSelectors);
    if (!capture.available || !capture.png) return null;
    const dimensions = pngDimensions(capture.png);
    return { png: capture.png, width: dimensions.width, height: dimensions.height };
  }

  /**
   * Captures the same page at several viewports and compares each against its own
   * baseline (`<pageKey>@<viewport>`), so a desktop-only check cannot hide a broken
   * tablet or mobile layout.
   */
  async validateVisualMatrix(options: {
    scanTaskId: string;
    url: string;
    pageKey: string;
    updateBaseline?: boolean;
    timeoutMs?: number;
    maskSelectors?: string[];
    viewports?: Array<{ name: string; width: number; height: number }>;
  }): Promise<{ results: VisualValidationResult[] }> {
    const scan = this.store.getScan(options.scanTaskId);
    if (!scan) throw new Error(`Unknown scan ${options.scanTaskId}`);

    const viewports = options.viewports?.length
      ? options.viewports
      : [
          { name: 'desktop', width: 1280, height: 900 },
          { name: 'tablet', width: 768, height: 1024 },
          { name: 'mobile', width: 390, height: 844 },
        ];

    const results: VisualValidationResult[] = [];
    for (const viewport of viewports) {
      results.push(
        await this.runVisualCheck({
          scan,
          url: options.url,
          baselineKey: `${options.pageKey}@${viewport.name}`,
          label: `${options.pageKey} · ${viewport.name}`,
          width: viewport.width,
          height: viewport.height,
          timeoutMs: options.timeoutMs ?? 20000,
          maskSelectors: options.maskSelectors ?? [],
          updateBaseline: Boolean(options.updateBaseline),
        }),
      );
    }
    return { results };
  }

  private async runVisualCheck(params: {
    scan: NonNullable<ReturnType<Store['getScan']>>;
    url: string;
    baselineKey: string;
    label: string;
    width: number;
    height: number;
    timeoutMs: number;
    maskSelectors: string[];
    updateBaseline: boolean;
  }): Promise<VisualValidationResult> {
    const { scan, url, baselineKey, label, width, height, timeoutMs, maskSelectors } = params;
    const started = Date.now();
    const pageKey = baselineKey.replace(/[^a-zA-Z0-9._@-]+/g, '-') || 'page';
    const dir = join(dataRoot(), 'visual', scan.projectId, pageKey);
    const base: VisualValidationResult = {
      available: false,
      pageKey,
      url,
      width,
      height,
      screenshotPath: '',
      baselinePath: null,
      baselineCreated: false,
      diffPercent: 0,
      changedPixels: 0,
      totalPixels: 0,
      dimensionMismatch: false,
      consoleErrors: [],
      durationMs: 0,
    };

    const capture = await this.capturePage(url, width, height, timeoutMs, maskSelectors);
    if (!capture.available || !capture.png) {
      return { ...base, available: false, reason: capture.reason, consoleErrors: capture.consoleErrors, durationMs: Date.now() - started };
    }

    mkdirSync(dir, { recursive: true });
    const screenshotPath = join(dir, `shot-${Date.now()}.png`);
    writeFileSync(screenshotPath, capture.png);
    const dimensions = pngDimensions(capture.png);

    const baseline = this.store.getVisualBaseline(scan.projectId, pageKey);
    const shouldCreate = !baseline || params.updateBaseline;
    if (shouldCreate) {
      const baselinePath = join(dir, 'baseline.png');
      copyFileSync(screenshotPath, baselinePath);
      this.store.upsertVisualBaseline({
        projectId: scan.projectId,
        pageKey,
        url,
        path: baselinePath,
        width: dimensions.width,
        height: dimensions.height,
        hash: sha256(readFileSync(baselinePath)),
      });
      this.store.insertValidationRun(scan.id, 'VISUAL', true, { pageKey, label, baselineCreated: true, masked: capture.maskedCount });
      return {
        ...base,
        available: true,
        screenshotPath,
        baselinePath,
        baselineCreated: true,
        width: dimensions.width,
        height: dimensions.height,
        totalPixels: dimensions.width * dimensions.height,
        consoleErrors: capture.consoleErrors,
        durationMs: Date.now() - started,
        screenshotDataUrl: toDataUrl(capture.png),
        baselineDataUrl: toDataUrl(capture.png),
      };
    }

    if (!existsSync(baseline.path)) {
      return {
        ...base,
        available: true,
        reason: 'Baseline file is missing on disk; capture a new baseline.',
        screenshotPath,
        consoleErrors: capture.consoleErrors,
        durationMs: Date.now() - started,
        screenshotDataUrl: toDataUrl(capture.png),
      };
    }

    const baselineBuffer = readFileSync(baseline.path);
    const diff = comparePngs(baselineBuffer, capture.png);
    const passed = diff.changedPixels === 0 && !diff.dimensionMismatch;
    this.store.insertValidationRun(scan.id, 'VISUAL', passed, {
      pageKey,
      label,
      diffPercent: diff.diffPercent,
      changedPixels: diff.changedPixels,
      dimensionMismatch: diff.dimensionMismatch,
      masked: capture.maskedCount,
    });

    return {
      ...base,
      available: true,
      width: diff.width,
      height: diff.height,
      screenshotPath,
      baselinePath: baseline.path,
      baselineCreated: false,
      diffPercent: diff.diffPercent,
      changedPixels: diff.changedPixels,
      totalPixels: diff.totalPixels,
      dimensionMismatch: diff.dimensionMismatch,
      consoleErrors: capture.consoleErrors,
      durationMs: Date.now() - started,
      screenshotDataUrl: toDataUrl(capture.png),
      baselineDataUrl: toDataUrl(baselineBuffer),
    };
  }

  private async capturePage(
    url: string,
    width: number,
    height: number,
    timeoutMs: number,
    maskSelectors: string[] = [],
  ): Promise<{ available: boolean; reason?: string; png: Buffer | null; consoleErrors: string[]; maskedCount: number }> {
    const moduleName = 'playwright';
    let playwright: {
      chromium: { launch: (options?: Record<string, unknown>) => Promise<BrowserInstance> };
    };
    try {
      playwright = (await import(moduleName)) as unknown as typeof playwright;
    } catch {
      return {
        available: false,
        reason:
          'Playwright is not installed. Install it (npm i -D playwright && npx playwright install chromium) to enable visual regression.',
        png: null,
        consoleErrors: [],
        maskedCount: 0,
      };
    }

    const consoleErrors: string[] = [];
    let browserInstance: BrowserInstance | null = null;
    try {
      browserInstance = await playwright.chromium.launch(launchOptions());
      const page = await browserInstance.newPage({ viewport: { width, height } } as Record<string, unknown>);
      page.on('console', (message: BrowserConsoleMessage) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error: Error) => consoleErrors.push(`pageerror: ${error.message}`));
      await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      // Single-page apps finish rendering after `load`: chunks, fonts and syntax
      // highlighting arrive later, and capturing mid-way produces diffs that look like
      // regressions. Wait for the network to go quiet, then let layout settle.
      await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10000) }).catch(() => undefined);
      await page.evaluate(() => new Promise((done) => setTimeout(done, 500)));

      // Volatile regions (clocks, carousels, ad slots) are masked rather than compared:
      // comparing them produces a diff on every run and hides real regressions.
      const mask = maskSelectors.map((selector) => page.locator(selector));
      const png = await page.screenshot({
        fullPage: true,
        type: 'png',
        animations: 'disabled',
        ...(mask.length > 0 ? { mask } : {}),
      } as Record<string, unknown>);
      return { available: true, png, consoleErrors: consoleErrors.slice(0, 50), maskedCount: mask.length };
    } catch (err) {
      return { available: false, reason: (err as Error).message, png: null, consoleErrors, maskedCount: 0 };
    } finally {
      await browserInstance?.close().catch(() => undefined);
    }
  }

  private async runBrowserCheck(url: string, timeoutMs: number): Promise<BrowserValidationResult> {
    // Resolved through a variable so TypeScript does not require playwright's types
    // to be installed: phase one treats browser validation as an optional add-on.
    const moduleName = 'playwright';
    let playwright: {
      chromium: { launch: (options?: Record<string, unknown>) => Promise<BrowserInstance> };
    };
    try {
      playwright = (await import(moduleName)) as unknown as typeof playwright;
    } catch {
      return {
        available: false,
        reason:
          'Playwright is not installed. Browser validation is optional in phase one; install playwright and run "npx playwright install chromium" to enable it.',
        navigationFailures: [],
        consoleErrors: [],
      };
    }

    const started = Date.now();
    const consoleErrors: string[] = [];
    const navigationFailures: string[] = [];
    let browserInstance: BrowserInstance | null = null;
    try {
      browserInstance = await playwright.chromium.launch(launchOptions());
      const page = await browserInstance.newPage();
      page.on('console', (message: BrowserConsoleMessage) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error: Error) => consoleErrors.push(`pageerror: ${error.message}`));
      page.on('requestfailed', (request: BrowserRequest) => {
        navigationFailures.push(`${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
      });
      const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      return {
        available: true,
        url,
        pageLoaded: Boolean(response),
        navigationFailures,
        consoleErrors: consoleErrors.slice(0, 50),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        available: true,
        url,
        pageLoaded: false,
        navigationFailures: [...navigationFailures, (err as Error).message],
        consoleErrors: consoleErrors.slice(0, 50),
        durationMs: Date.now() - started,
      };
    } finally {
      await browserInstance?.close().catch(() => undefined);
    }
  }
}

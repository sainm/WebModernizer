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
  async validateVisual(options: {
    scanTaskId: string;
    url: string;
    pageKey: string;
    updateBaseline?: boolean;
    width?: number;
    height?: number;
    timeoutMs?: number;
  }): Promise<VisualValidationResult> {
    const scan = this.store.getScan(options.scanTaskId);
    if (!scan) throw new Error(`Unknown scan ${options.scanTaskId}`);

    const width = options.width ?? 1280;
    const height = options.height ?? 900;
    const started = Date.now();
    const pageKey = options.pageKey.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'page';
    const dir = join(dataRoot(), 'visual', scan.projectId, pageKey);
    const base: VisualValidationResult = {
      available: false,
      pageKey,
      url: options.url,
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

    const capture = await this.capturePage(options.url, width, height, options.timeoutMs ?? 20000);
    if (!capture.available || !capture.png) {
      return { ...base, available: false, reason: capture.reason, consoleErrors: capture.consoleErrors, durationMs: Date.now() - started };
    }

    mkdirSync(dir, { recursive: true });
    const screenshotPath = join(dir, `shot-${Date.now()}.png`);
    writeFileSync(screenshotPath, capture.png);
    const dimensions = pngDimensions(capture.png);

    const baseline = this.store.getVisualBaseline(scan.projectId, pageKey);
    const shouldCreate = !baseline || options.updateBaseline;
    if (shouldCreate) {
      const baselinePath = join(dir, 'baseline.png');
      copyFileSync(screenshotPath, baselinePath);
      this.store.upsertVisualBaseline({
        projectId: scan.projectId,
        pageKey,
        url: options.url,
        path: baselinePath,
        width: dimensions.width,
        height: dimensions.height,
        hash: sha256(readFileSync(baselinePath)),
      });
      this.store.insertValidationRun(options.scanTaskId, 'VISUAL', true, { pageKey, baselineCreated: true });
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
    this.store.insertValidationRun(options.scanTaskId, 'VISUAL', passed, {
      pageKey,
      diffPercent: diff.diffPercent,
      changedPixels: diff.changedPixels,
      dimensionMismatch: diff.dimensionMismatch,
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
  ): Promise<{ available: boolean; reason?: string; png: Buffer | null; consoleErrors: string[] }> {
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
      // Give late layout (fonts, images) a moment to settle before capturing.
      await page.evaluate(() => new Promise((done) => setTimeout(done, 350)));
      const png = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' });
      return { available: true, png, consoleErrors: consoleErrors.slice(0, 50) };
    } catch (err) {
      return { available: false, reason: (err as Error).message, png: null, consoleErrors };
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

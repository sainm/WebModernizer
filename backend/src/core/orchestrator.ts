import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeParsedFile } from '../analysis/engine.js';
import { buildRelations, extractRefFacts, type FileRefFacts } from '../analysis/projectReferences.js';
import { RECIPE_RULE_IDS } from '../recipes/registry.js';
import { sha256, newId, nowIso } from '../model/ids.js';
import type { AnalysisFinding, ParseProblem, ScanPhase, ScanStatus, SourceFile } from '../model/types.js';
import { SCAN_PHASES } from '../model/types.js';
import { makeSourceFile, parseSourceFile } from '../parser/index.js';
import type { Store, ScanFileRow } from '../storage/store.js';
import { discoverFiles, modulePathOf, type DiscoveryResult } from './scanner.js';
import { decodeBuffer } from './textDecode.js';
import { writeScanReport } from './report.js';

export interface ScanEvent {
  scanId: string;
  type: 'status' | 'phase' | 'progress' | 'log' | 'done' | 'error';
  at: string;
  status?: ScanStatus;
  phase?: ScanPhase | null;
  message?: string;
  level?: 'info' | 'warn' | 'error';
  progress?: {
    scannedFiles: number;
    totalFiles: number;
    parsedFiles: number;
    failedFiles: number;
    findings: number;
    currentFile: string | null;
  };
  error?: string;
}

class CancelledError extends Error {
  constructor() {
    super('Scan cancelled');
  }
}

interface Runner {
  cancelled: boolean;
  emitter: EventEmitter;
  log: Array<{ at: string; level: string; phase: string | null; message: string }>;
}

const MAX_LOG_ENTRIES = 500;

export class ScanManager {
  private readonly store: Store;
  private readonly runners = new Map<string, Runner>();

  constructor(store: Store) {
    this.store = store;
  }

  start(scanId: string): void {
    const runner: Runner = { cancelled: false, emitter: new EventEmitter(), log: [] };
    this.runners.set(scanId, runner);
    void this.run(scanId, runner).catch((err) => {
      this.log(runner, scanId, 'error', null, `Unhandled scan failure: ${(err as Error).message}`);
    });
  }

  cancel(scanId: string): boolean {
    const runner = this.runners.get(scanId);
    if (!runner) {
      // Nothing in memory: the task either finished or was never started here.
      const task = this.store.getScan(scanId);
      if (task && (task.status === 'QUEUED' || task.status === 'RUNNING')) {
        this.store.updateScan(scanId, { status: 'CANCELLED', completedAt: nowIso() });
        return true;
      }
      return false;
    }
    runner.cancelled = true;
    return true;
  }

  isRunning(scanId: string): boolean {
    const runner = this.runners.get(scanId);
    return Boolean(runner && !runner.cancelled);
  }

  subscribe(scanId: string, listener: (event: ScanEvent) => void): () => void {
    const runner = this.runners.get(scanId);
    if (!runner) return () => undefined;
    runner.emitter.on('event', listener);
    return () => runner.emitter.off('event', listener);
  }

  private emit(runner: Runner, event: ScanEvent): void {
    runner.emitter.emit('event', event);
  }

  private log(runner: Runner, scanId: string, level: 'info' | 'warn' | 'error', phase: ScanPhase | null, message: string): void {
    const entry = { at: nowIso(), level, phase, message };
    runner.log.push(entry);
    if (runner.log.length > MAX_LOG_ENTRIES) runner.log.shift();
    this.emit(runner, { scanId, type: 'log', at: entry.at, level, message, phase });
  }

  private checkpoint(runner: Runner): void {
    if (runner.cancelled) throw new CancelledError();
  }

  private async run(scanId: string, runner: Runner): Promise<void> {
    const task = this.store.getScan(scanId);
    if (!task) {
      this.emit(runner, { scanId, type: 'error', at: nowIso(), error: `Unknown scan ${scanId}` });
      this.runners.delete(scanId);
      return;
    }

    const config = task.configSnapshot;
    const startedAt = nowIso();
    this.store.updateScan(scanId, { status: 'RUNNING', startedAt, phase: 'FILE_DISCOVERY' });
    this.emit(runner, { scanId, type: 'status', at: startedAt, status: 'RUNNING', phase: 'FILE_DISCOVERY' });

    const disabledRules = new Set<string>();
    for (const [ruleId, enabled] of this.store.listRuleStates()) {
      if (!enabled) disabledRules.add(ruleId);
    }

    const findings: AnalysisFinding[] = [];
    const problems: ParseProblem[] = [];
    const fileRows: ScanFileRow[] = [];
    const facts: FileRefFacts[] = [];
    let discovery: DiscoveryResult | null = null;
    let parsedCount = 0;
    let failedCount = 0;
    let scannedCount = 0;
    let activePhase: ScanPhase = 'FILE_DISCOVERY';

    const setPhase = (phase: ScanPhase): void => {
      activePhase = phase;
      this.store.updateScan(scanId, { phase });
      this.emit(runner, { scanId, type: 'phase', at: nowIso(), phase });
    };

    const emitProgress = (currentFile: string | null, force = false): void => {
      const total = discovery?.files.length ?? 0;
      this.emit(runner, {
        scanId,
        type: 'progress',
        at: nowIso(),
        progress: {
          scannedFiles: scannedCount,
          totalFiles: total,
          parsedFiles: parsedCount,
          failedFiles: failedCount,
          findings: findings.length,
          currentFile,
        },
        phase: activePhase,
      });
      if (force) {
        this.store.updateScan(scanId, {
          scannedFileCount: scannedCount,
          parsedFileCount: parsedCount,
          failedFileCount: failedCount,
          findingCount: findings.length,
          currentFile,
        });
      }
    };

    try {
      /* ---------------- phase 1: discovery ---------------- */
      this.log(runner, scanId, 'info', 'FILE_DISCOVERY', `Scanning ${task.rootPath}`);
      discovery = discoverFiles(task.rootPath, config);
      for (const warning of discovery.warnings) {
        this.log(runner, scanId, 'warn', 'FILE_DISCOVERY', warning);
      }
      this.checkpoint(runner);

      /* ---------------- phase 2: classification ---------------- */
      setPhase('FILE_CLASSIFICATION');
      const byLanguage: Record<string, number> = {};
      for (const file of discovery.files) {
        const key = file.extension;
        byLanguage[key] = (byLanguage[key] ?? 0) + 1;
      }
      this.log(
        runner,
        scanId,
        'info',
        'FILE_CLASSIFICATION',
        `Discovered ${discovery.files.length} candidate files (${Object.entries(byLanguage)
          .map(([ext, count]) => `${ext}:${count}`)
          .join(', ') || 'none'})`,
      );

      /* ---------------- phases 3-5: parse + detect ---------------- */
      setPhase('PARSING');
      let sinceYield = 0;
      for (const entry of discovery.files) {
        this.checkpoint(runner);
        scannedCount += 1;

        let sourceFile: SourceFile | null = null;
        let parseProblems: ParseProblem[] = [];
        let fileFindings: AnalysisFinding[] = [];
        let encoding = 'utf-8';
        let rawHash = '';
        let status: ScanFileRow['parseStatus'] = 'PARSED';

        try {
          const buffer = readFileSync(entry.absolutePath);
          rawHash = sha256(buffer);
          const decoded = decodeBuffer(buffer, {
            candidates: config.encodingCandidates,
            forceEncoding: config.forceEncoding,
          });
          encoding = decoded.encoding;
          if (decoded.replacementCount > 0) {
            problems.push({
              filePath: entry.relPath,
              phase: 'DECODE',
              message: `Decoded as ${encoding} with ${decoded.replacementCount} replacement characters; some text may be unreadable.`,
              recovered: true,
            });
          }
          if (decoded.source === 'FALLBACK') {
            problems.push({
              filePath: entry.relPath,
              phase: 'DECODE',
              message: 'Encoding could not be determined; fell back to UTF-8 with possible data loss.',
              recovered: true,
            });
          }

          sourceFile = makeSourceFile(task.rootPath, entry.relPath, entry.absolutePath, decoded.text);
          const parsed = parseSourceFile(sourceFile);
          parseProblems = parsed.problems;
          if (!parsed.parsed) status = 'FAILED';
          else if (parseProblems.some((p) => !p.recovered)) status = 'PARTIAL';

          if (parsed.parsed) {
            fileFindings = analyzeParsedFile(parsed, {
              scanTaskId: scanId,
              disabledRuleIds: disabledRules,
              recipeRuleIds: RECIPE_RULE_IDS,
            });
            facts.push(extractRefFacts(parsed));
          }
        } catch (err) {
          status = 'FAILED';
          parseProblems.push({
            filePath: entry.relPath,
            phase: 'READ',
            message: `Cannot read file: ${(err as Error).message}`,
            recovered: false,
          });
        }

        if (status === 'FAILED') failedCount += 1;
        else parsedCount += 1;

        problems.push(...parseProblems);
        findings.push(...fileFindings);
        fileRows.push({
          id: newId('fil'),
          scanTaskId: scanId,
          path: entry.relPath,
          language: sourceFile?.language ?? 'javascript',
          size: entry.size,
          hash: rawHash,
          encoding,
          parseStatus: status,
          findingCount: fileFindings.length,
        });

        if (scannedCount % 20 === 0) emitProgress(entry.relPath);
        else if (scannedCount === discovery.files.length) emitProgress(entry.relPath);

        sinceYield += 1;
        if (sinceYield >= 8) {
          sinceYield = 0;
          // Yield so cancellation and SSE writes are not starved by a long synchronous loop.
          await new Promise((resolve) => setImmediate(resolve));
          this.checkpoint(runner);
        }
      }

      /* ---------------- phase 6: references ---------------- */
      setPhase('REFERENCE_ANALYSIS');
      const allPaths = new Set(discovery.files.map((f) => f.relPath));
      const referenceResult = buildRelations(facts, allPaths);
      for (const item of referenceResult.unresolved.slice(0, 50)) {
        this.log(
          runner,
          scanId,
          'warn',
          'REFERENCE_ANALYSIS',
          `${item.from}:${item.line} unresolved reference "${item.raw}" — ${item.reason}`,
        );
      }
      this.checkpoint(runner);

      /* ---------------- phase 7: merge ---------------- */
      setPhase('FINDING_MERGE');
      findings.sort((a, b) => {
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        return a.startOffset - b.startOffset;
      });

      /* ---------------- phase 8: persistence ---------------- */
      setPhase('PERSISTENCE');
      this.store.insertScanFiles(fileRows);
      this.store.insertFindings(findings);
      this.store.insertParseProblems(scanId, problems);
      this.store.insertRelations(scanId, referenceResult.relations);
      this.store.updateScan(scanId, {
        scannedFileCount: scannedCount,
        parsedFileCount: parsedCount,
        failedFileCount: failedCount,
        findingCount: findings.length,
        currentFile: null,
        logJson: JSON.stringify(runner.log),
      });

      /* ---------------- phase 9: report ---------------- */
      setPhase('REPORT_GENERATION');
      const reportPath = writeScanReport(this.store, scanId);
      this.store.insertReport(scanId, 'json', reportPath);

      const finalStatus: ScanStatus = failedCount > 0 || discovery.skipped.length > 0 ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';
      const completedAt = nowIso();
      this.store.updateScan(scanId, {
        status: finalStatus,
        completedAt,
        phase: null,
        logJson: JSON.stringify(runner.log),
      });
      this.log(runner, scanId, 'info', null, `Scan finished: ${finalStatus} (${findings.length} findings)`);
      this.store.updateScan(scanId, { logJson: JSON.stringify(runner.log) });
      this.emit(runner, {
        scanId,
        type: 'done',
        at: completedAt,
        status: finalStatus,
        progress: {
          scannedFiles: scannedCount,
          totalFiles: discovery.files.length,
          parsedFiles: parsedCount,
          failedFiles: failedCount,
          findings: findings.length,
          currentFile: null,
        },
      });
    } catch (err) {
      if (err instanceof CancelledError) {
        // Keep whatever was analyzed so far; never leave the task in RUNNING.
        try {
          if (fileRows.length) this.store.insertScanFiles(fileRows);
          if (findings.length) this.store.insertFindings(findings);
          if (problems.length) this.store.insertParseProblems(scanId, problems);
        } catch {
          // Persisting partial results must not mask the cancellation.
        }
        const completedAt = nowIso();
        this.store.updateScan(scanId, {
          status: 'CANCELLED',
          completedAt,
          phase: null,
          scannedFileCount: scannedCount,
          parsedFileCount: parsedCount,
          failedFileCount: failedCount,
          findingCount: findings.length,
          currentFile: null,
          logJson: JSON.stringify(runner.log),
        });
        this.log(runner, scanId, 'warn', null, 'Scan cancelled by user');
        this.emit(runner, { scanId, type: 'done', at: completedAt, status: 'CANCELLED' });
      } else {
        const message = (err as Error).message;
        const completedAt = nowIso();
        this.store.updateScan(scanId, {
          status: 'FAILED',
          completedAt,
          phase: null,
          errorSummary: message,
          logJson: JSON.stringify(runner.log),
        });
        this.log(runner, scanId, 'error', null, `Scan failed: ${message}`);
        this.emit(runner, { scanId, type: 'error', at: completedAt, status: 'FAILED', error: message });
      }
    } finally {
      this.runners.delete(scanId);
    }
  }
}

export { SCAN_PHASES };
export type { DiscoveryResult };

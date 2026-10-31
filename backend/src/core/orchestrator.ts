import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCrossFileHandlerFindings } from '../analysis/crossFileHandlers.js';
import { analyzeParsedFile } from '../analysis/engine.js';
import { buildRelations, extractRefFacts, type FileRefFacts } from '../analysis/projectReferences.js';
import { RECIPE_RULE_IDS, ruleSignature } from '../recipes/registry.js';
import { sha256, newId, nowIso } from '../model/ids.js';
import type { AnalysisFinding, ParseProblem, ProjectConfig, ScanPhase, ScanStatus, ScanTask, SourceFile } from '../model/types.js';
import { SCAN_PHASES } from '../model/types.js';
import { makeSourceFile, parseSourceFile } from '../parser/index.js';
import type { FindingStatusUpdate, Store, ScanFileRow } from '../storage/store.js';
import { discoverFiles, modulePathOf, type DiscoveryResult } from './scanner.js';
import { decodeBuffer } from './textDecode.js';
import { writeScanReport } from './report.js';
import { IGNORE_NOTE_PREFIX, findIgnoreMatch, ignoreNote } from './ignoreRules.js';
import { compareFindings } from './compare.js';
import { createParsePool, poolSizeFromEnv, type ParsePool } from './parsePool.js';
import { acquireProjectLock, defaultLockWaitMs, projectBusyReason } from './projectLock.js';
import { verifyManualFixes } from './verification.js';

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

interface PreparedFile {
  entry: DiscoveryResult['files'][number];
  hash: string;
  encoding: string;
  language: ScanFileRow['language'];
  status: ScanFileRow['parseStatus'];
  findings: AnalysisFinding[];
  problems: ParseProblem[];
  facts: FileRefFacts | null;
  reused: boolean;
}

interface WorkerAnalyzeReply {
  ok: boolean;
  error?: string;
  hash?: string;
  encoding?: string;
  language?: ScanFileRow['language'];
  replacementCount?: number;
  decodeSource?: string;
  parsedOk?: boolean;
  problems?: ParseProblem[];
  findings?: AnalysisFinding[];
  facts?: FileRefFacts | null;
}

/** Maps a worker reply to the same shape the in-process path produces. */
function toPrepared(entry: DiscoveryResult['files'][number], reply: WorkerAnalyzeReply): PreparedFile {
  if (!reply.ok) {
    return {
      entry,
      hash: reply.hash ?? '',
      encoding: 'utf-8',
      language: 'javascript',
      status: 'FAILED',
      findings: [],
      problems: [{ filePath: entry.relPath, phase: 'READ', message: reply.error ?? 'Worker failed', recovered: false }],
      facts: null,
      reused: false,
    };
  }

  const problems: ParseProblem[] = [];
  if ((reply.replacementCount ?? 0) > 0) {
    problems.push({
      filePath: entry.relPath,
      phase: 'DECODE',
      message: `Decoded as ${reply.encoding} with ${reply.replacementCount} replacement characters; some text may be unreadable.`,
      recovered: true,
    });
  }
  if (reply.decodeSource === 'FALLBACK') {
    problems.push({
      filePath: entry.relPath,
      phase: 'DECODE',
      message: 'Encoding could not be determined; fell back to UTF-8 with possible data loss.',
      recovered: true,
    });
  }
  const parsedProblems = reply.problems ?? [];
  problems.push(...parsedProblems);

  const status: ScanFileRow['parseStatus'] = !reply.parsedOk
    ? 'FAILED'
    : parsedProblems.some((problem) => !problem.recovered)
      ? 'PARTIAL'
      : 'PARSED';

  return {
    entry,
    hash: reply.hash ?? '',
    encoding: reply.encoding ?? 'utf-8',
    language: reply.language ?? 'javascript',
    status,
    findings: reply.findings ?? [],
    problems,
    facts: reply.facts ?? null,
    reused: false,
  };
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
  projectId: string;
  lockToken: string;
}

const MAX_LOG_ENTRIES = 500;
/** Files parsed between two event loop turns when no worker pool is used. */
const YIELD_EVERY_FILES = 8;
const DEFAULT_FLUSH_EVERY_FILES = 25;

function flushBatchSize(): number {
  const raw = Number(process.env.WEBLIFT_SCAN_FLUSH_EVERY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_FLUSH_EVERY_FILES;
}

const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export class ScanManager {
  private readonly store: Store;
  private readonly lockWaitMs: number;
  private readonly runners = new Map<string, Runner>();

  constructor(store: Store, options: { lockWaitMs?: number } = {}) {
    this.store = store;
    this.lockWaitMs = options.lockWaitMs ?? defaultLockWaitMs();
    this.store.markInterruptedScans(process.pid);
  }

  start(scanId: string): { ok: boolean; reason?: string; queued?: boolean } {
    const scan = this.store.getScan(scanId);
    if (!scan) return { ok: false, reason: `Unknown scan ${scanId}` };
    if (scan.status !== 'QUEUED') return { ok: false, reason: `Scan ${scanId} is ${scan.status}, not queued` };
    if (this.runners.has(scanId)) return { ok: false, reason: `Scan ${scanId} is already started` };

    const lockToken = newId('lck');
    const lock = this.store.tryAcquireProjectLock(scan.projectId, process.pid, lockToken);
    if (lock.ok) {
      const runner: Runner = { cancelled: false, emitter: new EventEmitter(), log: [], projectId: scan.projectId, lockToken };
      this.runners.set(scanId, runner);
      void this.run(scanId, runner).catch((err) => {
        this.log(runner, scanId, 'error', null, `Unhandled scan failure: ${(err as Error).message}`);
      });
      return { ok: true };
    }

    const reason = projectBusyReason(lock);
    if (this.lockWaitMs <= 0) {
      this.store.updateScan(scanId, {
        status: 'FAILED',
        completedAt: nowIso(),
        waitingFor: null,
        errorSummary: reason,
        currentFile: null,
      });
      return { ok: false, reason };
    }

    const runner: Runner = { cancelled: false, emitter: new EventEmitter(), log: [], projectId: scan.projectId, lockToken };
    this.runners.set(scanId, runner);
    this.store.updateScan(scanId, { waitingFor: reason, runnerPid: process.pid });
    void this.waitForLock(scanId, scan, runner).catch((err) => {
      this.log(runner, scanId, 'error', null, `Unhandled scan wait failure: ${(err as Error).message}`);
    });
    return { ok: true, queued: true };
  }

  private async waitForLock(scanId: string, scan: ScanTask, runner: Runner): Promise<void> {
    const outcome = await acquireProjectLock(this.store, scan.projectId, process.pid, runner.lockToken, {
      waitMs: this.lockWaitMs,
      isCancelled: () => runner.cancelled,
    });

    if (runner.cancelled) {
      this.runners.delete(scanId);
      this.store.updateScan(scanId, {
        status: 'CANCELLED',
        completedAt: nowIso(),
        waitingFor: null,
        currentFile: null,
      });
      this.emit(runner, { scanId, type: 'done', at: nowIso(), status: 'CANCELLED' });
      return;
    }

    if (outcome.result.ok) {
      this.store.updateScan(scanId, { waitingFor: null });
      try {
        await this.run(scanId, runner);
      } catch (err) {
        this.store.releaseProjectLock(runner.projectId, runner.lockToken);
        this.runners.delete(scanId);
        const current = this.store.getScan(scanId);
        if (!current || (current.status !== 'QUEUED' && current.status !== 'RUNNING')) return;
        const reason = `The scan could not start after waiting for the project lock: ${(err as Error).message}`;
        this.store.updateScan(scanId, {
          status: 'FAILED',
          completedAt: nowIso(),
          waitingFor: null,
          errorSummary: reason,
          currentFile: null,
        });
        this.emit(runner, { scanId, type: 'error', at: nowIso(), status: 'FAILED', error: reason });
      }
      return;
    }

    this.runners.delete(scanId);
    const reason = outcome.timedOut
      ? `Timed out after ${Math.ceil(outcome.waitedMs / 1000)}s waiting for another operation on this project. ${projectBusyReason(outcome.result)}`
      : projectBusyReason(outcome.result);
    this.store.updateScan(scanId, {
      status: 'FAILED',
      completedAt: nowIso(),
      waitingFor: null,
      errorSummary: reason,
      currentFile: null,
    });
    this.emit(runner, { scanId, type: 'error', at: nowIso(), status: 'FAILED', error: reason });
  }

  cancel(scanId: string): boolean {
    const runner = this.runners.get(scanId);
    if (!runner) {
      // Nothing in memory: the task either finished or was never started here.
      const task = this.store.getScan(scanId);
      if (task && (task.status === 'QUEUED' || task.status === 'RUNNING')) {
        this.store.updateScan(scanId, { status: 'CANCELLED', completedAt: nowIso(), waitingFor: null });
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

  /**
   * Turns the discovered files into findings, either by reusing the previous scan or by
   * reading and parsing. With a pool the work runs in worker threads; without one it runs
   * here. Both paths return the same shape, so the apply phase cannot diverge.
   */
  private async prepareFiles(options: {
    entries: DiscoveryResult['files'];
    scan: ScanTask;
    scanTaskId: string;
    config: ProjectConfig;
    disabledRuleIds: Set<string>;
    previous: ScanTask | null;
    previousFiles: Map<string, ScanFileRow> | null;
    previousFindings: Map<string, AnalysisFinding[]>;
    previousFacts: Map<string, FileRefFacts> | null;
    pool: ParsePool | null;
    runner: Runner;
    onProgress: (done: number, currentFile: string | null) => void;
    /** Called as soon as one file is finished, so a cancelled scan can persist progress. */
    onFileReady?: (file: PreparedFile, index: number) => void;
  }): Promise<PreparedFile[]> {
    const { entries, scan, scanTaskId, config, disabledRuleIds, previous, previousFiles, previousFindings, previousFacts, runner, onProgress, onFileReady } = options;
    const results: Array<PreparedFile | null> = new Array(entries.length).fill(null);

    // The pool is an optimisation, never a requirement: if workers cannot start in this
    // environment, the scan continues in-process instead of failing every file.
    let activePool = options.pool;
    if (activePool && entries.length > 0) {
      try {
        await activePool.run({ op: 'hash', absPath: entries[0].absolutePath });
      } catch (err) {
        this.log(runner, scanTaskId, 'warn', 'PARSING', `Worker pool unavailable (${(err as Error).message}); parsing in-process`);
        await activePool.close().catch(() => undefined);
        activePool = null;
      }
    }

    /* ---- pass 1: hashes, only where a reuse decision is possible ---- */
    // A different size cannot be the same file, so those go straight to parsing.
    const hashIndexes: number[] = [];
    if (previous && previousFiles) {
      entries.forEach((entry, index) => {
        const reusable = previousFiles.get(entry.relPath);
        if (reusable && reusable.size === entry.size) hashIndexes.push(index);
      });
    }

    const hashByIndex = new Map<number, string>();
    if (hashIndexes.length > 0) {
      this.checkpoint(runner);
      if (activePool) {
        const replies = await activePool.map<{ hash: string }>(
          hashIndexes.map((index) => ({ op: 'hash', absPath: entries[index].absolutePath })),
        );
        hashIndexes.forEach((index, position) => hashByIndex.set(index, replies[position].hash));
      } else {
        for (const index of hashIndexes) {
          hashByIndex.set(index, sha256(readFileSync(entries[index].absolutePath)));
        }
      }
    }

    /* ---- pass 2: reuse what matches, queue the rest ---- */
    const analyzeIndexes: number[] = [];
    entries.forEach((entry, index) => {
      const reusable = previous && previousFiles ? previousFiles.get(entry.relPath) : null;
      const hash = hashByIndex.get(index);
      if (reusable && hash && reusable.hash === hash) {
        results[index] = {
          entry,
          hash,
          encoding: reusable.encoding,
          language: reusable.language,
          status: reusable.parseStatus === 'SKIPPED' ? 'PARSED' : reusable.parseStatus,
          findings: (previousFindings.get(entry.relPath) ?? []).map((finding) => ({
            ...finding,
            id: newId('fnd'),
            scanTaskId,
          })),
          problems: [],
          facts: previousFacts?.get(entry.relPath) ?? null,
          reused: true,
        };
        onFileReady?.(results[index] as PreparedFile, index);
        return;
      }
      analyzeIndexes.push(index);
    });

    /* ---- pass 3: read + parse + detect ---- */
    if (analyzeIndexes.length > 0) {
      this.checkpoint(runner);
      if (activePool) {
        const replies = await Promise.all(
          analyzeIndexes.map((index) =>
            activePool
              .run<WorkerAnalyzeReply>({
                op: 'analyze',
                rootPath: scan.rootPath,
                relPath: entries[index].relPath,
                absPath: entries[index].absolutePath,
                scanTaskId,
                encodingCandidates: config.encodingCandidates,
                forceEncoding: config.forceEncoding,
                disabledRuleIds: [...disabledRuleIds],
              })
              .then((reply) => {
                // The pool starts every file at once, so cancellation is checked per reply
                // rather than once for the batch.
                if (runner.cancelled) throw new CancelledError();
                const prepared = toPrepared(entries[index], reply);
                results[index] = prepared;
                onFileReady?.(prepared, index);
                return reply;
              }),
          ),
        );
        void replies;
        onProgress(entries.length, null);
      } else {
        let done = hashIndexes.length;
        let sinceYield = 0;
        for (const index of analyzeIndexes) {
          this.checkpoint(runner);
          results[index] = this.analyzeInProcess(entries[index], scan, scanTaskId, config, disabledRuleIds);
          onFileReady?.(results[index] as PreparedFile, index);
          done += 1;
          onProgress(done, entries[index].relPath);
          // Parsing is synchronous, so without an explicit yield a large project blocks the
          // event loop for the whole run: progress never reaches the UI and a cancel request
          // cannot even be read. Every few files the loop takes a breath.
          sinceYield += 1;
          if (sinceYield >= YIELD_EVERY_FILES) {
            sinceYield = 0;
            await yieldToEventLoop();
          }
        }
      }
    }

    // A fully incremental scan never enters the parse loop, so without this the run would report
    // "0 of 11 scanned" for a project where every file was accounted for.
    onProgress(entries.length, null);

    return results.map((item, index) => {
      if (item) return item;
      // Defensive: an entry that produced nothing is reported as unreadable, never dropped.
      return {
        entry: entries[index],
        hash: '',
        encoding: 'utf-8',
        language: 'javascript' as const,
        status: 'FAILED' as const,
        findings: [],
        problems: [{ filePath: entries[index].relPath, phase: 'READ' as const, message: 'File was not processed.', recovered: false }],
        facts: null,
        reused: false,
      };
    });
  }

  /** Single-file path used when the pool is disabled or unavailable. */
  private analyzeInProcess(
    entry: DiscoveryResult['files'][number],
    scan: ScanTask,
    scanTaskId: string,
    config: ProjectConfig,
    disabledRuleIds: Set<string>,
  ): PreparedFile {
    try {
      const buffer = readFileSync(entry.absolutePath);
      const hash = sha256(buffer);
      const decoded = decodeBuffer(buffer, { candidates: config.encodingCandidates, forceEncoding: config.forceEncoding });
      const problems: ParseProblem[] = [];
      if (decoded.replacementCount > 0) {
        problems.push({
          filePath: entry.relPath,
          phase: 'DECODE',
          message: `Decoded as ${decoded.encoding} with ${decoded.replacementCount} replacement characters; some text may be unreadable.`,
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

      const sourceFile = makeSourceFile(scan.rootPath, entry.relPath, entry.absolutePath, decoded.text);
      const parsed = parseSourceFile(sourceFile);
      problems.push(...parsed.problems);
      const status: ScanFileRow['parseStatus'] = !parsed.parsed
        ? 'FAILED'
        : parsed.problems.some((problem) => !problem.recovered)
          ? 'PARTIAL'
          : 'PARSED';
      const findings = parsed.parsed
        ? analyzeParsedFile(parsed, { scanTaskId, disabledRuleIds, recipeRuleIds: RECIPE_RULE_IDS })
        : [];
      return {
        entry,
        hash,
        encoding: decoded.encoding,
        language: sourceFile.language,
        status,
        findings,
        problems,
        facts: parsed.parsed ? extractRefFacts(parsed) : null,
        reused: false,
      };
    } catch (err) {
      return {
        entry,
        hash: '',
        encoding: 'utf-8',
        language: 'javascript',
        status: 'FAILED',
        findings: [],
        problems: [{ filePath: entry.relPath, phase: 'READ', message: `Cannot read file: ${(err as Error).message}`, recovered: false }],
        facts: null,
        reused: false,
      };
    }
  }

  private checkpoint(runner: Runner): void {
    if (runner.cancelled) throw new CancelledError();
  }

  private async run(scanId: string, runner: Runner): Promise<void> {
    const task = this.store.getScan(scanId);
    if (!task) {
      this.emit(runner, { scanId, type: 'error', at: nowIso(), error: `Unknown scan ${scanId}` });
      this.runners.delete(scanId);
      this.store.releaseProjectLock(runner.projectId, runner.lockToken);
      return;
    }

    const config = task.configSnapshot;
    const startedAt = nowIso();
    this.store.updateScan(scanId, {
      status: 'RUNNING',
      startedAt,
      phase: 'FILE_DISCOVERY',
      runnerPid: process.pid,
      waitingFor: null,
    });
    this.emit(runner, { scanId, type: 'status', at: startedAt, status: 'RUNNING', phase: 'FILE_DISCOVERY' });

    // Project decisions to stop reporting specific patterns are applied at scan time,
    // so an accepted risk does not come back on every run.
    const ignoreRules = this.store.listIgnoreRules(task.projectId);
    let ignoredCount = 0;

    const disabledRules = new Set<string>();
    for (const [ruleId, enabled] of this.store.listRuleStates()) {
      if (!enabled) disabledRules.add(ruleId);
    }

    const findings: AnalysisFinding[] = [];
    const facts: FileRefFacts[] = [];
    const reusedPaths = new Set<string>();
    const analyzableFiles = new Set<string>();
    let pendingRows: ScanFileRow[] = [];
    let pendingFindings: AnalysisFinding[] = [];
    let pendingProblems: ParseProblem[] = [];
    let pendingFacts: FileRefFacts[] = [];
    let discovery: DiscoveryResult | null = null;
    let parsedCount = 0;
    let failedCount = 0;
    let persistedFiles = 0;
    let persistedParsed = 0;
    let persistedFailed = 0;
    let persistedFindings = 0;
    let scannedCount = 0;
    let activePhase: ScanPhase = 'FILE_DISCOVERY';

    // Files prepared so far, keyed by their discovery index, plus a guard so the accumulation
    // below runs at most once per file whether it arrives from the callback or the final loop.
    const preparedByIndex = new Map<number, PreparedFile>();
    const acceptedIndexes = new Set<number>();

    /**
     * Moves one prepared file into the scan's accumulators. Called both while preparing (so a
     * cancelled scan keeps what it already finished) and after preparation returns.
     */
    const acceptFile = (item: PreparedFile, index: number): void => {
      if (acceptedIndexes.has(index)) return;
      acceptedIndexes.add(index);
      if (item.status === 'FAILED') failedCount += 1;
      else parsedCount += 1;
      if (item.status === 'PARSED') analyzableFiles.add(item.entry.relPath);
      pendingProblems.push(...item.problems);
      if (item.reused) reusedPaths.add(item.entry.relPath);
      if (item.facts) {
        facts.push(item.facts);
        pendingFacts.push(item.facts);
      }

      const fileFindings = item.findings;
      for (const finding of fileFindings) {
        const match = findIgnoreMatch(finding, ignoreRules);
        if (match) {
          finding.status = 'IGNORED';
          finding.statusNote = ignoreNote(match.rule, match.reason);
          finding.statusUpdatedAt = nowIso();
          ignoredCount += 1;
          continue;
        }
        // A reused finding may carry a rule note from a rule that has since been removed.
        if (item.reused && finding.status === 'IGNORED' && (finding.statusNote ?? '').startsWith(IGNORE_NOTE_PREFIX)) {
          finding.status = finding.migrationLevel === 'SAFE' || finding.migrationLevel === 'CONDITIONAL'
            ? 'READY_FOR_MIGRATION'
            : 'DETECTED';
          finding.statusNote = undefined;
        }
      }
      findings.push(...fileFindings);
      pendingFindings.push(...fileFindings);
      pendingRows.push({
        id: newId('fil'),
        scanTaskId: scanId,
        path: item.entry.relPath,
        language: item.language,
        size: item.entry.size,
        hash: item.hash,
        encoding: item.encoding,
        parseStatus: item.status,
        findingCount: fileFindings.length,
        reused: item.reused,
      });
    };

    /** Accepts every buffered file in discovery order, skipping the ones already accepted. */
    const drainPrepared = (): void => {
      for (const index of [...preparedByIndex.keys()].sort((a, b) => a - b)) {
        const item = preparedByIndex.get(index);
        if (item) acceptFile(item, index);
      }
    };

    const flush = (currentFile: string | null): void => {
      if (pendingRows.length === 0 && pendingFindings.length === 0 && pendingProblems.length === 0 && pendingFacts.length === 0) {
        this.store.updateScan(scanId, {
          scannedFileCount: acceptedIndexes.size,
          parsedFileCount: parsedCount,
          failedFileCount: failedCount,
          findingCount: findings.length,
          currentFile,
        });
        return;
      }
      this.store.insertScanBatch(scanId, {
        files: pendingRows,
        findings: pendingFindings,
        problems: pendingProblems,
        facts: pendingFacts,
        counts: {
          scanned: acceptedIndexes.size,
          parsed: parsedCount,
          failed: failedCount,
          findings: findings.length,
          currentFile,
        },
      });
      persistedFiles += pendingRows.length;
      persistedParsed += pendingRows.filter((row) => row.parseStatus !== 'FAILED').length;
      persistedFailed += pendingRows.filter((row) => row.parseStatus === 'FAILED').length;
      persistedFindings += pendingFindings.length;
      pendingRows = [];
      pendingFindings = [];
      pendingProblems = [];
      pendingFacts = [];
    };

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
      const discoveredFiles = discovery.files;
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

      /* ---------------- phases 3-5: prepare (read + parse + detect) ---------------- */
      setPhase('PARSING');
      // Recorded before parsing starts, so an interrupted scan can still report "48 of 400"
      // instead of implying that 48 was the whole project.
      this.store.updateScan(scanId, { totalFileCount: discoveredFiles.length });

      // Incremental scan: an unchanged file whose rules have not changed either can reuse
      // the previous results. The rule signature guards against reusing findings that a
      // changed rule set would no longer produce.
      const signature = ruleSignature();
      // A cancelled or failed scan is a valid reuse source, not just a completed one: whatever
      // it persisted is complete *per file* (a file is either fully analysed or absent), so
      // starting a new scan after an interruption resumes where the old one stopped instead of
      // re-parsing everything.
      const reusableStatuses = new Set<ScanStatus>(['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'CANCELLED', 'FAILED']);
      const previous = this.store
        .listScans(task.projectId, 5)
        .find(
          (candidate) =>
            candidate.id !== scanId && candidate.ruleSignature === signature && reusableStatuses.has(candidate.status),
        ) ?? null;
      const previousFiles = previous ? new Map(this.store.listScanFiles(previous.id).map((file) => [file.path, file])) : null;
      // One query for the whole previous scan instead of one per file: on a 1 400-file
      // project that turns 1 400 round trips into a single read.
      const previousFindings = new Map<string, AnalysisFinding[]>();
      const previousFacts = previous
        ? new Map(this.store.listFileFacts(previous.id).map((fact) => [fact.path, fact]))
        : null;
      if (previous) {
        for (const finding of this.store.listAllFindings(previous.id)) {
          const list = previousFindings.get(finding.filePath) ?? [];
          list.push(finding);
          previousFindings.set(finding.filePath, list);
        }
        const partial = previous.status === 'CANCELLED' || previous.status === 'FAILED';
        this.log(
          runner,
          scanId,
          'info',
          'PARSING',
          `${partial ? 'Resuming from partial' : 'Incremental: comparing against'} scan ${previous.id}` +
            (partial ? ` (${this.store.listScanFiles(previous.id).length} file(s) already analysed)` : ''),
        );
      }

      const pool = createParsePool();
      if (pool) this.log(runner, scanId, 'info', 'PARSING', `Parsing with ${poolSizeFromEnv()} worker(s)`);
      const flushEvery = flushBatchSize();
      let readySinceFlush = 0;
      let prepared: PreparedFile[];
      try {
        prepared = await this.prepareFiles({
          entries: discoveredFiles,
          scan: task,
          scanTaskId: scanId,
          config,
          disabledRuleIds: disabledRules,
          previous,
          previousFiles,
          previousFindings,
          previousFacts,
          pool,
          runner,
          onProgress: (done: number, currentFile: string | null) => {
            scannedCount = done;
            if (done % 20 === 0 || done === discoveredFiles.length) emitProgress(currentFile);
          },
          onFileReady: (file: PreparedFile, index: number) => {
            preparedByIndex.set(index, file);
            acceptFile(file, index);
            readySinceFlush += 1;
            if (readySinceFlush >= flushEvery) {
              readySinceFlush = 0;
              flush(file.entry.relPath);
            }
          },
        });
      } finally {
        await pool?.close();
      }
      this.checkpoint(runner);

      /* ---------------- apply: reuse notes, ignore rules, rows ---------------- */
      prepared.forEach((item, index) => acceptFile(item, index));
      flush(null);

      const crossFile = buildCrossFileHandlerFindings(
        facts.map((fact) => ({ path: fact.path, facts: fact })),
        scanId,
      );
      const suppressedByFile = new Map<string, Set<number>>();
      for (const item of crossFile.suppressed) {
        const starts = suppressedByFile.get(item.filePath) ?? new Set<number>();
        for (const start of item.starts) starts.add(start);
        suppressedByFile.set(item.filePath, starts);
      }
      const supersededHandlers = new Set(crossFile.superseded.map((item) => `${item.filePath}|${item.handlerStart}`));
      let supersededCount = 0;
      for (let index = findings.length - 1; index >= 0; index -= 1) {
        const finding = findings[index];
        if (finding.ruleId !== 'WL-JS-017') continue;
        const handlerStart = finding.evidence.detail?.handlerStart;
        if (typeof handlerStart !== 'number') continue;
        if (!supersededHandlers.has(`${finding.filePath}|${handlerStart}`)) continue;
        if (finding.status === 'IGNORED') ignoredCount -= 1;
        if (this.store.deleteFinding(finding.id)) {
          this.store.incrementScanFileFindingCount(scanId, finding.filePath, -1);
        }
        findings.splice(index, 1);
        supersededCount += 1;
      }

      let suppressedCount = 0;
      for (let index = findings.length - 1; index >= 0; index -= 1) {
        const finding = findings[index];
        if (finding.ruleId !== 'WL-JS-003') continue;
        if (!suppressedByFile.get(finding.filePath)?.has(finding.startOffset)) continue;
        if (finding.status === 'IGNORED') ignoredCount -= 1;
        if (this.store.deleteFinding(finding.id)) {
          this.store.incrementScanFileFindingCount(scanId, finding.filePath, -1);
        }
        findings.splice(index, 1);
        suppressedCount += 1;
      }
      for (const finding of crossFile.findings) {
        const match = findIgnoreMatch(finding, ignoreRules);
        if (match) {
          finding.status = 'IGNORED';
          finding.statusNote = ignoreNote(match.rule, match.reason);
          finding.statusUpdatedAt = nowIso();
          ignoredCount += 1;
        }
        findings.push(finding);
        pendingFindings.push(finding);
        this.store.incrementScanFileFindingCount(scanId, finding.filePath, 1);
      }
      if (crossFile.findings.length > 0 || suppressedCount > 0 || supersededCount > 0) {
        this.log(
          runner,
          scanId,
          'info',
          'FINDING_MERGE',
          `${crossFile.findings.length} cross-file handler finding(s); ` +
            `suppressed ${suppressedCount} covered window.event finding(s); replaced ${supersededCount} per-file handler finding(s)`,
        );
      }

      /* ---------------- phase 6: references ---------------- */
      setPhase('REFERENCE_ANALYSIS');
      const allPaths = new Set(discovery.files.map((f) => f.relPath));
      const referenceResult = buildRelations(facts, allPaths);

      if (previous && reusedPaths.size > 0) {
        const missingFacts = new Set([...reusedPaths].filter((path) => !previousFacts?.has(path)));
        if (missingFacts.size > 0) {
          const seen = new Set(referenceResult.relations.map((rel) => `${rel.fromPath}|${rel.toPath}|${rel.kind}`));
          for (const relation of this.store.listRelations(previous.id)) {
            if (!missingFacts.has(relation.fromPath)) continue;
            const key = `${relation.fromPath}|${relation.toPath}|${relation.kind}`;
            if (seen.has(key)) continue;
            seen.add(key);
            referenceResult.relations.push(relation);
          }
          this.log(
            runner,
            scanId,
            'warn',
            'REFERENCE_ANALYSIS',
            `${missingFacts.size} reused file(s) have no stored reference facts; their relations were copied from scan ${previous.id}.`,
          );
        }
      }
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
      flush(null);
      this.store.insertRelations(scanId, referenceResult.relations);
      if (reusedPaths.size > 0) {
        this.log(runner, scanId, 'info', 'FINDING_MERGE', `Reused ${reusedPaths.size} unchanged file(s) from ${previous?.id}`);
      }

      const previousList = previous ? [...previousFindings.values()].flat() : [];
      if (previous) {
        const outcomes = verifyManualFixes({
          previous: previousList,
          current: findings,
          parsedFiles: analyzableFiles,
          disabledRules,
        });
        const updates: FindingStatusUpdate[] = [];
        let validated = 0;
        let failed = 0;
        for (const outcome of outcomes) {
          if (outcome.result === 'VALIDATED') {
            validated += 1;
            updates.push({
              id: outcome.previous.id,
              status: 'VALIDATED',
              actor: 'system:verification',
              note: `Not found in scan ${scanId}.`,
            });
            continue;
          }
          failed += 1;
          const ignored = outcome.current?.status === 'IGNORED';
          updates.push({
            id: outcome.previous.id,
            status: 'VALIDATION_FAILED',
            actor: 'system:verification',
            note: `Still found in scan ${scanId}${ignored ? ' (ignored by a project rule there)' : ''}.`,
          });
          if (outcome.current && !ignored) {
            updates.push({
              id: outcome.current.id,
              status: 'VALIDATION_FAILED',
              actor: 'system:verification',
              note: `Previously marked fixed in scan ${previous.id}, still found.`,
            });
          }
        }
        this.store.applyStatusUpdates(updates);
        if (outcomes.length > 0) {
          this.log(
            runner,
            scanId,
            'info',
            'PERSISTENCE',
            `Manual fix verification against scan ${previous.id}: ${validated} validated, ${failed} failed`,
          );
        }
      }

      // How much moved since the previous scan. The same comparison the Compare page runs on
      // demand is recorded here, so a trend is available without recomputing it per page view —
      // and so "fixed 12, introduced 3" survives the next scan overwriting the numbers.
      const delta = previous ? compareFindings(previousList, findings) : null;
      if (delta) {
        this.log(
          runner,
          scanId,
          'info',
          'FINDING_MERGE',
          `Since scan ${previous?.id}: ${delta.resolved.length} fixed, ${delta.added.length} new, ${delta.unchanged} unchanged`,
        );
      }
      this.store.updateScan(scanId, {
        scannedFileCount: acceptedIndexes.size,
        parsedFileCount: parsedCount,
        failedFileCount: failedCount,
        findingCount: findings.length,
        comparedScanId: previous?.id ?? null,
        resolvedCount: delta?.resolved.length ?? 0,
        addedCount: delta?.added.length ?? 0,
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
      if (ignoredCount > 0) {
        this.log(runner, scanId, 'info', 'FINDING_MERGE', `${ignoredCount} finding(s) marked ignored by project rules`);
      }
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
          drainPrepared();
          flush(null);
        } catch {
          // Persisting partial results must not mask the cancellation.
        }
        const completedAt = nowIso();
        this.store.updateScan(scanId, {
          status: 'CANCELLED',
          completedAt,
          // Kept on purpose: "stopped during parsing" is the only useful answer to
          // "where did it stop", and it is what the phase list renders.
          phase: activePhase,
          scannedFileCount: persistedFiles,
          parsedFileCount: persistedParsed,
          failedFileCount: persistedFailed,
          findingCount: persistedFindings,
          currentFile: null,
          logJson: JSON.stringify(runner.log),
        });
        this.log(runner, scanId, 'warn', null, 'Scan cancelled by user');
        this.emit(runner, { scanId, type: 'done', at: completedAt, status: 'CANCELLED' });
      } else {
        const message = (err as Error).message;
        // Keep the finished files: a failure halfway through a 5 000-file project should not
        // throw away the 4 000 that were analysed, and persisting them makes the next scan a
        // resume rather than a restart.
        try {
          drainPrepared();
          flush(null);
        } catch {
          // Persisting partial results must not mask the original failure.
        }
        const completedAt = nowIso();
        this.store.updateScan(scanId, {
          status: 'FAILED',
          completedAt,
          phase: activePhase,
          errorSummary: message,
          scannedFileCount: persistedFiles,
          parsedFileCount: persistedParsed,
          failedFileCount: persistedFailed,
          findingCount: persistedFindings,
          currentFile: null,
          logJson: JSON.stringify(runner.log),
        });
        this.log(runner, scanId, 'error', null, `Scan failed: ${message}`);
        this.emit(runner, { scanId, type: 'error', at: completedAt, status: 'FAILED', error: message });
      }
    } finally {
      this.runners.delete(scanId);
      this.store.releaseProjectLock(runner.projectId, runner.lockToken);
    }
  }
}

export { SCAN_PHASES };
export type { DiscoveryResult };

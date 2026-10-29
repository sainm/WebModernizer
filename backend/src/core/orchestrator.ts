import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeParsedFile } from '../analysis/engine.js';
import { buildRelations, extractRefFacts, type FileRefFacts } from '../analysis/projectReferences.js';
import { RECIPE_RULE_IDS, ruleSignature } from '../recipes/registry.js';
import { sha256, newId, nowIso } from '../model/ids.js';
import type { AnalysisFinding, ParseProblem, ProjectConfig, ScanPhase, ScanStatus, ScanTask, SourceFile } from '../model/types.js';
import { SCAN_PHASES } from '../model/types.js';
import { makeSourceFile, parseSourceFile } from '../parser/index.js';
import type { Store, ScanFileRow } from '../storage/store.js';
import { discoverFiles, modulePathOf, type DiscoveryResult } from './scanner.js';
import { decodeBuffer } from './textDecode.js';
import { writeScanReport } from './report.js';
import { IGNORE_NOTE_PREFIX, findIgnoreMatch, ignoreNote } from './ignoreRules.js';
import { createParsePool, poolSizeFromEnv, type ParsePool } from './parsePool.js';

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
}

const MAX_LOG_ENTRIES = 500;
/** Files parsed between two event loop turns when no worker pool is used. */
const YIELD_EVERY_FILES = 8;

const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

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
    pool: ParsePool | null;
    runner: Runner;
    onProgress: (done: number, currentFile: string | null) => void;
    /** Called as soon as one file is finished, so a cancelled scan can persist progress. */
    onFileReady?: (file: PreparedFile, index: number) => void;
  }): Promise<PreparedFile[]> {
    const { entries, scan, scanTaskId, config, disabledRuleIds, previous, previousFiles, previousFindings, runner, onProgress, onFileReady } = options;
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
          facts: null,
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
      return;
    }

    const config = task.configSnapshot;
    const startedAt = nowIso();
    this.store.updateScan(scanId, { status: 'RUNNING', startedAt, phase: 'FILE_DISCOVERY' });
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
    const problems: ParseProblem[] = [];
    const fileRows: ScanFileRow[] = [];
    const facts: FileRefFacts[] = [];
    const reusedPaths = new Set<string>();
    let discovery: DiscoveryResult | null = null;
    let parsedCount = 0;
    let failedCount = 0;
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
      problems.push(...item.problems);
      if (item.reused) reusedPaths.add(item.entry.relPath);
      if (item.facts) facts.push(item.facts);

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
      fileRows.push({
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
          pool,
          runner,
          onProgress: (done: number, currentFile: string | null) => {
            scannedCount = done;
            if (done % 20 === 0 || done === discoveredFiles.length) emitProgress(currentFile);
          },
          // Buffer, do not accumulate: files finish out of order when a pool is used, and the
          // final ordering should still follow the discovery order.
          onFileReady: (file: PreparedFile, index: number) => {
            preparedByIndex.set(index, file);
          },
        });
      } finally {
        await pool?.close();
      }
      this.checkpoint(runner);

      /* ---------------- apply: reuse notes, ignore rules, rows ---------------- */
      prepared.forEach((item, index) => acceptFile(item, index));

      /* ---------------- phase 6: references ---------------- */
      setPhase('REFERENCE_ANALYSIS');
      const allPaths = new Set(discovery.files.map((f) => f.relPath));
      const referenceResult = buildRelations(facts, allPaths);

      // Reused files were not parsed, so their outgoing references come from the previous
      // scan. Targets may have changed, but the source file did not.
      if (previous && reusedPaths.size > 0) {
        const seen = new Set(referenceResult.relations.map((rel) => `${rel.fromPath}|${rel.toPath}|${rel.kind}`));
        for (const relation of this.store.listRelations(previous.id)) {
          if (!reusedPaths.has(relation.fromPath)) continue;
          const key = `${relation.fromPath}|${relation.toPath}|${relation.kind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          referenceResult.relations.push(relation);
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
      this.store.insertScanFiles(fileRows);
      this.store.insertFindings(findings);
      this.store.insertParseProblems(scanId, problems);
      this.store.insertRelations(scanId, referenceResult.relations);
      if (reusedPaths.size > 0) {
        this.log(runner, scanId, 'info', 'FINDING_MERGE', `Reused ${reusedPaths.size} unchanged file(s) from ${previous?.id}`);
      }
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
          // Kept on purpose: "stopped during parsing" is the only useful answer to
          // "where did it stop", and it is what the phase list renders.
          phase: activePhase,
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
        // Keep the finished files: a failure halfway through a 5 000-file project should not
        // throw away the 4 000 that were analysed, and persisting them makes the next scan a
        // resume rather than a restart.
        try {
          drainPrepared();
          if (fileRows.length) this.store.insertScanFiles(fileRows);
          if (findings.length) this.store.insertFindings(findings);
          if (problems.length) this.store.insertParseProblems(scanId, problems);
        } catch {
          // Persisting partial results must not mask the original failure.
        }
        const completedAt = nowIso();
        this.store.updateScan(scanId, {
          status: 'FAILED',
          completedAt,
          phase: activePhase,
          errorSummary: message,
          scannedFileCount: scannedCount,
          parsedFileCount: parsedCount,
          failedFileCount: failedCount,
          findingCount: findings.length,
          currentFile: null,
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

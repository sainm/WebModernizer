import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AnalysisFinding,
  MigrationExecution,
  MigrationPlan,
  MigrationPlanItem,
  MigrationVisualResult,
  TextEdit,
} from '../model/types.js';
import { newId, nowIso, sha256 } from '../model/ids.js';
import { parseSourceFile, makeSourceFile } from '../parser/index.js';
import { recipeForFinding } from '../recipes/registry.js';
import type { Store } from '../storage/store.js';
import { applyEdits, diffLines, toUnifiedDiff } from './diff.js';
import { comparePngs, toDataUrl } from './imageDiff.js';
import { dataRoot } from './report.js';
import { resolveProjectPath } from './scanner.js';

export interface PreviewOptions {
  scanTaskId: string;
  findingIds: string[];
}

export interface VisualPage {
  pageKey: string;
  url: string;
}

export interface VisualCapture {
  /** Takes one screenshot of the page as it exists right now. */
  capture(url: string): Promise<{ png: Buffer; width: number; height: number } | null>;
}

export interface ExecuteOptions {
  /**
   * Screenshot the given pages around the write. Capturing happens after the plan is
   * prepared but before anything is written, so "before" really is the pre-migration page.
   */
  visual?: { pages: VisualPage[]; capture: VisualCapture['capture'] };
}

export interface ExecuteResult {
  ok: boolean;
  executions: MigrationExecution[];
  failures: Array<{ findingId: string; filePath: string; reason: string }>;
  warnings: string[];
  /** Identifies this execute() call, across every file it touched. */
  sessionId: string;
  /** True when the plan was rejected and nothing was written. */
  aborted: boolean;
  /** Before/after comparison, only when the caller asked for it. */
  visual: MigrationVisualResult[];
}

/** A file whose edits are computed and verified but not yet on disk. */
interface PreparedFile {
  filePath: string;
  absPath: string;
  newText: string;
  beforeHash: string;
  batchId: string;
  backupPath: string;
  items: MigrationPlanItem[];
}

/** Writes to a temp file in the same directory, then renames, preserving permissions. */
function writeFileAtomic(absPath: string, content: string): void {
  const tempPath = `${absPath}.weblift-tmp-${Date.now()}`;
  const originalMode = statSync(absPath).mode & 0o7777;
  writeFileSync(tempPath, content, { encoding: 'utf8', mode: originalMode });
  renameSync(tempPath, absPath);
  // rename() replaces the inode, so the target now carries the temp file's mode. Writing the
  // content again would not fix that: writeFileSync only applies `mode` when it creates a file.
  if ((statSync(absPath).mode & 0o7777) !== originalMode) chmodSync(absPath, originalMode);
}

function backupRoot(): string {
  const dir = join(dataRoot(), 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface TargetFile {
  absPath: string;
  text: string;
  hash: string;
  /** UTF-8 byte-order mark of the original, re-emitted on write so nothing else changes. */
  bom: string;
}

/**
 * Reads a project file the way the scan read it. Decoding with the recorded encoding keeps
 * recipe offsets valid (they were computed against that text) and keeps the diff readable
 * instead of full of U+FFFD. The hash still covers the raw bytes.
 */
function readTarget(rootPath: string, relPath: string, encoding: string | null | undefined): TargetFile | null {
  const absPath = resolveProjectPath(rootPath, relPath);
  if (!absPath || !existsSync(absPath)) return null;
  const buffer = readFileSync(absPath);
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = hasBom ? buffer.subarray(3) : buffer;
  let text: string;
  try {
    text = new TextDecoder(encoding ?? 'utf-8', { fatal: false }).decode(body);
  } catch {
    text = body.toString('utf8');
  }
  return { absPath, text, hash: sha256(buffer), bom: hasBom ? '\uFEFF' : '' };
}

/** True when the bytes on disk can be written back without changing their encoding. */
function isWritableEncoding(encoding: string | null | undefined): boolean {
  const normalized = (encoding ?? 'utf-8').toLowerCase().replace(/[_\s]/g, '-');
  return normalized === 'utf-8' || normalized === 'utf8';
}

/**
 * Preview never writes to the project. It re-reads the source, re-parses it and
 * re-runs the recipe preconditions, so the diff always reflects the current file
 * rather than the state captured during the scan.
 */
export class MigrationService {
  constructor(private readonly store: Store) {}

  preview(options: PreviewOptions): MigrationPlan {
    const scan = this.store.getScan(options.scanTaskId);
    if (!scan) throw new Error(`Unknown scan ${options.scanTaskId}`);
    const warnings: string[] = [];
    const items: MigrationPlanItem[] = [];

    const findings: AnalysisFinding[] = [];
    for (const id of options.findingIds) {
      const finding = this.store.getFinding(id);
      if (!finding) {
        warnings.push(`Finding ${id} not found`);
        continue;
      }
      if (finding.scanTaskId !== options.scanTaskId) {
        warnings.push(`Finding ${id} belongs to another scan`);
        continue;
      }
      findings.push(finding);
    }

    const byFile = new Map<string, AnalysisFinding[]>();
    for (const finding of findings) {
      const list = byFile.get(finding.filePath) ?? [];
      list.push(finding);
      byFile.set(finding.filePath, list);
    }

    for (const [filePath, fileFindings] of byFile) {
      const scannedFile = this.store.getScanFile(options.scanTaskId, filePath);
      const target = readTarget(scan.rootPath, filePath, scannedFile?.encoding);
      if (!target) {
        for (const finding of fileFindings) {
          items.push(this.blockedItem(finding, 'File no longer exists on disk.', true));
        }
        continue;
      }

      // A file the tool cannot encode back is not a file it may rewrite. Reading it as UTF-8
      // would turn every Shift_JIS / EUC-JP character into U+FFFD and writing it back would
      // persist that loss, so the whole file is refused until the encoding is handled properly.
      if (!isWritableEncoding(scannedFile?.encoding)) {
        for (const finding of fileFindings) {
          items.push(
            this.blockedItem(
              finding,
              `This file is ${scannedFile?.encoding}, and rewriting it would re-encode the whole file as UTF-8 and destroy every non-ASCII character in it. Convert the file to UTF-8 first, then rescan.`,
            ),
          );
        }
        continue;
      }

      const hashMatches = scannedFile ? scannedFile.hash === target.hash : false;
      if (!hashMatches) {
        warnings.push(
          `${filePath} changed since the scan; the diff is recomputed against the current content and execution will require a re-scan.`,
        );
      }

      const sourceFile = makeSourceFile(scan.rootPath, filePath, target.absPath, target.text);
      const parsed = parseSourceFile(sourceFile);
      const occupied: Array<{ start: number; end: number }> = [];

      for (const finding of fileFindings) {
        if (finding.status === 'IGNORED') {
          items.push(this.blockedItem(finding, 'This finding is ignored by a project rule; re-enable it before migrating.'));
          continue;
        }
        const recipe = recipeForFinding(finding);
        if (!recipe) {
          items.push(this.blockedItem(finding, 'No automated recipe exists for this rule.'));
          continue;
        }

        const precondition = recipe.preconditions(finding, { text: target.text, parsed });
        if (!precondition.ok) {
          items.push({
            findingId: finding.id,
            ruleId: finding.ruleId,
            recipeId: recipe.id,
            filePath,
            migrationLevel: finding.migrationLevel,
            applicable: false,
            blockedReasons: precondition.reasons,
            fileHashAtPreview: target.hash,
            edits: [],
            diff: [],
            unifiedDiff: '',
            previewBefore: '',
            previewAfter: '',
            startLine: finding.startLine,
            staleFile: !hashMatches,
          });
          continue;
        }

        const edits = recipe.plan(finding, { text: target.text, parsed });
        if (!edits || edits.length === 0) {
          items.push(this.blockedItem(finding, 'The recipe could not produce a safe edit for the current code.'));
          continue;
        }

        const overlap = edits.some((edit) => occupied.some((range) => edit.start < range.end && edit.end > range.start));
        if (overlap) {
          items.push(this.blockedItem(finding, 'This edit overlaps another selected finding in the same file; migrate them separately.'));
          continue;
        }
        for (const edit of edits) occupied.push({ start: edit.start, end: edit.end });

        let afterText: string;
        try {
          afterText = applyEdits(target.text, edits);
        } catch (err) {
          items.push(this.blockedItem(finding, `Edit could not be applied: ${(err as Error).message}`));
          continue;
        }

        const diff = diffLines(target.text, afterText);
        const windowStart = Math.max(1, finding.startLine - 4);
        const windowEnd = finding.endLine + 4;
        const beforeLines = target.text.split('\n').slice(windowStart - 1, windowEnd).join('\n');
        const delta = afterText.split('\n').length - target.text.split('\n').length;
        const afterLines = afterText
          .split('\n')
          .slice(windowStart - 1, windowEnd + delta)
          .join('\n');

        items.push({
          findingId: finding.id,
          ruleId: finding.ruleId,
          recipeId: recipe.id,
          filePath,
          migrationLevel: recipe.level,
          applicable: hashMatches,
          blockedReasons: hashMatches
            ? precondition.reasons
            : ['The file changed after the scan; re-run the scan before executing this migration.'],
          fileHashAtPreview: target.hash,
          edits,
          diff,
          unifiedDiff: toUnifiedDiff(target.text, afterText, filePath),
          previewBefore: beforeLines,
          previewAfter: afterLines,
          startLine: finding.startLine,
          staleFile: !hashMatches,
        });
      }
    }

    return {
      planId: newId('plan'),
      projectId: scan.projectId,
      scanTaskId: options.scanTaskId,
      items,
      warnings,
    };
  }

  private blockedItem(finding: AnalysisFinding, reason: string, staleFile = false): MigrationPlanItem {
    return {
      findingId: finding.id,
      ruleId: finding.ruleId,
      recipeId: '',
      filePath: finding.filePath,
      migrationLevel: finding.migrationLevel,
      applicable: false,
      blockedReasons: [reason],
      fileHashAtPreview: '',
      edits: [],
      diff: [],
      unifiedDiff: '',
      previewBefore: '',
      previewAfter: '',
      startLine: finding.startLine,
      staleFile,
    };
  }

  /**
   * Applies a previewed plan. Every file is verified against the hash captured at
   * preview time, backed up, written atomically and re-parsed. Any failure restores
   * the backup before returning, so a broken transformation never lands on disk.
   */
  /**
   * Applies a previewed plan as one transaction across every file it touches.
   *
   * Two phases:
   *   prepare — verify hashes, back up, apply edits in memory, re-parse each file;
   *   commit  — write each file atomically, compensating already-written files if a
   *             later write fails.
   *
   * Findings whose preconditions are not met are excluded up front (they were never
   * part of the plan). Anything that fails during prepare or commit aborts the whole
   * transaction: a multi-file plan either lands completely or not at all.
   */
  async execute(scanTaskId: string, findingIds: string[], options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const scan = this.store.getScan(scanTaskId);
    if (!scan) throw new Error(`Unknown scan ${scanTaskId}`);

    const plan = this.preview({ scanTaskId, findingIds });
    const sessionId = newId('ses');
    const skipped: ExecuteResult['failures'] = [];
    const prepared: PreparedFile[] = [];
    const warnings = [...plan.warnings];

    const stale = plan.items.filter((item) => item.staleFile);
    if (stale.length > 0) {
      // The user confirmed a plan against a specific file state; that state is gone.
      return this.abort(
        sessionId,
        stale.map((item) => ({
          findingId: item.findingId,
          filePath: item.filePath,
          reason: 'The file changed after the scan; re-run the scan and preview again before applying.',
        })),
        warnings,
      );
    }

    const byFile = new Map<string, MigrationPlanItem[]>();
    for (const item of plan.items) {
      if (!item.applicable) {
        skipped.push({ findingId: item.findingId, filePath: item.filePath, reason: item.blockedReasons.join('; ') });
        continue;
      }
      const list = byFile.get(item.filePath) ?? [];
      list.push(item);
      byFile.set(item.filePath, list);
    }

    /* ---------------------------- phase 1: prepare ---------------------------- */
    for (const [filePath, items] of byFile) {
      const target = readTarget(scan.rootPath, filePath, this.store.getScanFile(scanTaskId, filePath)?.encoding);
      if (!target) {
        return this.abort(sessionId, [{ findingId: items[0].findingId, filePath, reason: 'File disappeared before execution.' }], warnings);
      }

      const expectedHash = items[0].fileHashAtPreview;
      if (target.hash !== expectedHash) {
        return this.abort(
          sessionId,
          [{ findingId: items[0].findingId, filePath, reason: 'File changed between preview and execution; nothing was written.' }],
          warnings,
        );
      }

      const batchId = newId('bat');
      const executionId = newId('mig');
      const backupPath = join(backupRoot(), executionId, filePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(target.absPath, backupPath);
      if (sha256(readFileSync(backupPath)) !== expectedHash) {
        return this.abort(sessionId, [{ findingId: items[0].findingId, filePath, reason: 'Backup verification failed.' }], warnings);
      }

      const edits: TextEdit[] = items.flatMap((item) => item.edits);
      let afterText: string;
      try {
        afterText = applyEdits(target.text, edits);
      } catch (err) {
        return this.abort(sessionId, [{ findingId: items[0].findingId, filePath, reason: (err as Error).message }], warnings);
      }

      // Syntax gate: a transformation that breaks parsing is rejected before any write.
      const parsedAfter = parseSourceFile(makeSourceFile(scan.rootPath, filePath, target.absPath, afterText));
      const hardErrors = parsedAfter.problems.filter((problem) => !problem.recovered);
      if (hardErrors.length > 0) {
        return this.abort(
          sessionId,
          [{ findingId: items[0].findingId, filePath, reason: `Transformation rejected: result does not parse (${hardErrors[0].message}).` }],
          warnings,
        );
      }

      prepared.push({
        filePath,
        absPath: target.absPath,
        // The BOM is not part of the text the recipes reason about, but it is part of the file.
        newText: target.bom + afterText,
        beforeHash: expectedHash,
        batchId,
        backupPath,
        items,
      });
    }

    if (prepared.length === 0) {
      return { ok: false, executions: [], failures: skipped, warnings, sessionId, aborted: true, visual: [] };
    }

    /* ------------------- optional: capture the pages before writing ------------------- */
    const visualPages = options.visual?.pages ?? [];
    const beforeShots = new Map<string, { png: Buffer; width: number; height: number } | null>();
    if (visualPages.length > 0 && options.visual) {
      for (const page of visualPages) {
        try {
          beforeShots.set(page.pageKey, await options.visual.capture(page.url));
        } catch {
          beforeShots.set(page.pageKey, null);
        }
      }
    }

    /* ---------------------------- phase 2: commit ---------------------------- */
    const written: PreparedFile[] = [];
    for (const file of prepared) {
      try {
        writeFileAtomic(file.absPath, file.newText);
        written.push(file);
      } catch (err) {
        // Compensate in reverse order: the transaction must leave no half-applied state.
        const reverted: string[] = [];
        for (const done of [...written].reverse()) {
          try {
            copyFileSync(done.backupPath, done.absPath);
            reverted.push(done.filePath);
          } catch {
            // Reported below; the backup still exists on disk for manual recovery.
          }
        }
        return this.abort(
          sessionId,
          [
            {
              findingId: file.items[0].findingId,
              filePath: file.filePath,
              reason: `Write failed (${(err as Error).message}). Reverted: ${reverted.join(', ') || 'nothing needed reverting'}.`,
            },
          ],
          warnings,
        );
      }
    }

    /* ---------------------------- record results ---------------------------- */
    const executions: MigrationExecution[] = [];
    for (const file of written) {
      const afterHash = sha256(readFileSync(file.absPath));
      for (const item of file.items) {
        const execution: MigrationExecution = {
          id: newId('exe'),
          projectId: scan.projectId,
          scanTaskId,
          ruleId: item.ruleId,
          findingId: item.findingId,
          filePath: file.filePath,
          beforeHash: file.beforeHash,
          afterHash,
          diff: item.unifiedDiff,
          executionStatus: 'APPLIED',
          validationStatus: 'PENDING',
          executedAt: nowIso(),
          rolledBackAt: null,
          backupPath: file.backupPath,
          note: [item.recipeId, ...item.blockedReasons].filter(Boolean).join(' | '),
          batchId: file.batchId,
          sessionId,
        };
        this.store.insertMigration(execution);
        this.store.updateFindingStatus(item.findingId, 'MIGRATED', 'system:migration', `Applied ${item.recipeId}`);
        executions.push(execution);
      }
    }

    if (skipped.length > 0) warnings.push(`${skipped.length} finding(s) were excluded before execution; see failures for reasons.`);

    const visual = await this.compareAfterMigration(scanTaskId, visualPages, beforeShots, options.visual?.capture, warnings);

    return { ok: true, executions, failures: skipped, warnings, sessionId, aborted: false, visual };
  }

  /** Aborts a transaction: nothing has been written, so only the reason is reported. */
  private abort(sessionId: string, failures: ExecuteResult['failures'], warnings: string[]): ExecuteResult {
    return {
      ok: false,
      executions: [],
      failures,
      warnings: [...warnings, 'Nothing was written: the migration is applied per plan, and this plan was rejected.'],
      sessionId,
      aborted: true,
      visual: [],
    };
  }

  /**
   * Rolls back everything one execute() call did. Refuses if any file drifted after the
   * migration, because restoring would discard newer edits.
   */
  rollbackSession(sessionId: string): RollbackResult {
    const rows = this.store.listMigrationsBySession(sessionId);
    if (rows.length === 0) return { ok: false, reason: 'Unknown session' };
    return this.rollbackRows(rows, sessionId, 'session');
  }
  /**
   * Captures the pages again and diffs them against the pre-write screenshots. A visual
   * failure never fails the migration: the files are already written and validated by
   * other means, so the result is recorded as data, not as an error.
   */
  private async compareAfterMigration(
    scanTaskId: string,
    pages: VisualPage[],
    beforeShots: Map<string, { png: Buffer; width: number; height: number } | null>,
    capture: VisualCapture['capture'] | undefined,
    warnings: string[],
  ): Promise<MigrationVisualResult[]> {
    if (pages.length === 0 || !capture) return [];

    const results: MigrationVisualResult[] = [];
    for (const page of pages) {
      const before = beforeShots.get(page.pageKey) ?? null;
      if (!before) {
        results.push({
          pageKey: page.pageKey,
          url: page.url,
          captured: false,
          reason: 'The page could not be captured before the migration; nothing to compare.',
          width: 0,
          height: 0,
          diffPercent: 0,
          changedPixels: 0,
          totalPixels: 0,
          dimensionMismatch: false,
        });
        continue;
      }

      let after: { png: Buffer; width: number; height: number } | null = null;
      try {
        after = await capture(page.url);
      } catch {
        after = null;
      }
      if (!after) {
        results.push({
          pageKey: page.pageKey,
          url: page.url,
          captured: false,
          reason: 'The page could not be captured after the migration (is the app still running?).',
          width: before.width,
          height: before.height,
          diffPercent: 0,
          changedPixels: 0,
          totalPixels: 0,
          dimensionMismatch: false,
          beforeDataUrl: toDataUrl(before.png),
        });
        continue;
      }

      const diff = comparePngs(before.png, after.png);
      results.push({
        pageKey: page.pageKey,
        url: page.url,
        captured: true,
        width: diff.width,
        height: diff.height,
        diffPercent: diff.diffPercent,
        changedPixels: diff.changedPixels,
        totalPixels: diff.totalPixels,
        dimensionMismatch: diff.dimensionMismatch,
        beforeDataUrl: toDataUrl(before.png),
        afterDataUrl: toDataUrl(after.png),
      });
    }

    const changed = results.filter((result) => result.captured && result.changedPixels > 0).length;
    if (changed > 0) warnings.push(`${changed} page(s) changed visually after the migration; review the before/after images.`);

    // Keep the comparison in history so it is not only visible in this response.
    this.store.insertValidationRun(scanTaskId, 'VISUAL_MIGRATION', changed === 0, { results: results.map(({ beforeDataUrl, afterDataUrl, ...rest }) => rest) });
    return results;
  }

  /**
   * Rolling back one row means rolling back what that execute() call did, because a
   * multi-file transaction is restored as a unit. Legacy rows without a session fall
   * back to their batch, then to themselves.
   */
  rollback(executionId: string): RollbackResult {
    const execution = this.store.getMigration(executionId);
    if (!execution) return { ok: false, reason: 'Unknown execution' };
    if (execution.sessionId) return this.rollbackSession(execution.sessionId);
    if (execution.batchId) {
      const rows = this.store.listMigrationsByBatch(execution.batchId);
      return this.rollbackRows(rows, execution.batchId, 'batch');
    }
    return this.rollbackRows([execution], null, 'batch');
  }

  rollbackBatch(batchId: string): RollbackResult {
    const rows = this.store.listMigrationsByBatch(batchId);
    if (rows.length === 0) return { ok: false, reason: 'Unknown batch' };
    return this.rollbackRows(rows, batchId, 'batch');
  }

  private rollbackRows(
    rows: MigrationExecution[],
    groupId: string | null,
    scope: 'batch' | 'session',
  ): RollbackResult {
    const active = rows.filter((row) => row.executionStatus === 'APPLIED');
    if (active.length === 0) {
      return { ok: false, reason: 'Already rolled back', affectedFindings: 0, batchId: groupId, sessionId: groupId };
    }

    // One restore unit per file: a batch shares a backup and an afterHash.
    const batches = new Map<string, MigrationExecution[]>();
    for (const row of active) {
      const key = row.batchId ?? row.id;
      const list = batches.get(key) ?? [];
      list.push(row);
      batches.set(key, list);
    }

    // Verify everything first: a partially restored transaction is worse than a refusal.
    const restores: Array<{ target: string; backupPath: string }> = [];
    for (const [key, batchRows] of batches) {
      const first = batchRows[0];
      if (!existsSync(first.backupPath)) {
        return { ok: false, reason: `Backup file is missing for ${first.filePath}; restore from version control.`, affectedFindings: 0, batchId: key, sessionId: groupId };
      }
      const scan = this.store.getScan(first.scanTaskId);
      if (!scan) return { ok: false, reason: 'Unknown scan for this execution', affectedFindings: 0, batchId: key, sessionId: groupId };

      const target = resolveProjectPath(scan.rootPath, first.filePath);
      if (!target) return { ok: false, reason: 'Target path escapes the project root', affectedFindings: 0, batchId: key, sessionId: groupId };

      const currentHash = existsSync(target) ? sha256(readFileSync(target)) : '';
      if (currentHash && currentHash !== first.afterHash) {
        return {
          ok: false,
          reason: `${first.filePath} changed after the migration; rolling back would discard newer edits. Restore from version control instead.`,
          affectedFindings: 0,
          batchId: key,
          sessionId: groupId,
        };
      }
      restores.push({ target, backupPath: first.backupPath });
    }

    for (const restore of restores) {
      try {
        copyFileSync(restore.backupPath, restore.target);
      } catch (err) {
        return { ok: false, reason: `Restore failed: ${(err as Error).message}`, affectedFindings: 0, batchId: groupId, sessionId: groupId };
      }
    }

    const at = nowIso();
    for (const row of active) {
      this.store.updateMigration(row.id, { executionStatus: 'ROLLED_BACK', rolledBackAt: at });
      this.store.updateFindingStatus(
        row.findingId,
        'READY_FOR_MIGRATION',
        'system:rollback',
        scope === 'session' ? `Rolled back session ${groupId}` : `Rolled back batch ${groupId}`,
      );
    }
    return {
      ok: true,
      affectedFindings: active.length,
      batchId: scope === 'batch' ? groupId : null,
      sessionId: scope === 'session' ? groupId : null,
    };
  }
}

export interface RollbackResult {
  ok: boolean;
  reason?: string;
  /** Number of findings reverted by this call (a whole session or batch). */
  affectedFindings?: number;
  batchId?: string | null;
  sessionId?: string | null;
}

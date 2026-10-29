import { readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { analyzeParsedFile } from '../analysis/engine.js';
import { extractRefFacts } from '../analysis/projectReferences.js';
import { sha256 } from '../model/ids.js';
import { makeSourceFile, parseSourceFile } from '../parser/index.js';
import { RECIPE_RULE_IDS } from '../recipes/registry.js';
import { decodeBuffer } from './textDecode.js';

/**
 * Worker entry point for one file at a time.
 *
 * Two operations:
 *   hash    — read and digest only; used to decide whether a file can be reused.
 *   analyze — read, decode, parse, analyse; returns everything the main thread needs.
 *
 * File I/O is inside the worker on purpose: on this machine reading 1 400 small files
 * costs more than parsing them, so parallelising only the CPU half would barely help.
 */
interface HashTask {
  id: number;
  op: 'hash';
  absPath: string;
}

interface AnalyzeTask {
  id: number;
  op: 'analyze';
  rootPath: string;
  relPath: string;
  absPath: string;
  scanTaskId: string;
  encodingCandidates: string[];
  forceEncoding?: string;
  disabledRuleIds: string[];
}

export type WorkerTask = HashTask | AnalyzeTask;

/**
 * What the caller supplies: the same union without the id the pool assigns.
 * Written as a union of Omit<> rather than Omit<union> — the latter collapses to the
 * common keys, which silently drops every analyze-only field.
 */
export type WorkerTaskInput = Omit<HashTask, 'id'> | Omit<AnalyzeTask, 'id'>;

if (!parentPort) {
  throw new Error('parseWorker must be started as a worker thread');
}

parentPort.on('message', (task: WorkerTask) => {
  try {
    if (task.op === 'hash') {
      const buffer = readFileSync(task.absPath);
      parentPort?.postMessage({ id: task.id, ok: true, hash: sha256(buffer), size: buffer.length });
      return;
    }

    const buffer = readFileSync(task.absPath);
    const hash = sha256(buffer);
    const decoded = decodeBuffer(buffer, {
      candidates: task.encodingCandidates,
      forceEncoding: task.forceEncoding,
    });
    const sourceFile = makeSourceFile(task.rootPath, task.relPath, task.absPath, decoded.text);
    const parsed = parseSourceFile(sourceFile);
    const findings = parsed.parsed
      ? analyzeParsedFile(parsed, {
          scanTaskId: task.scanTaskId,
          disabledRuleIds: new Set(task.disabledRuleIds),
          recipeRuleIds: RECIPE_RULE_IDS,
        })
      : [];
    const facts = parsed.parsed ? extractRefFacts(parsed) : null;

    parentPort?.postMessage({
      id: task.id,
      ok: true,
      hash,
      size: buffer.length,
      encoding: decoded.encoding,
      replacementCount: decoded.replacementCount,
      decodeSource: decoded.source,
      language: sourceFile.language,
      parsedOk: parsed.parsed,
      problems: parsed.problems,
      findings,
      facts,
    });
  } catch (err) {
    parentPort?.postMessage({ id: task.id, ok: false, error: (err as Error).message });
  }
});

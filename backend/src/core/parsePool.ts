import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { WorkerTask, WorkerTaskInput } from './parseWorker.js';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * Small fixed-size worker pool.
 *
 * The scanner is I/O plus CPU per file with no shared state, which is exactly the shape a
 * worker pool handles well. Workers are long-lived: spawning one costs more than parsing a
 * small file, so recycling per task would be slower than staying single-threaded.
 */
export class ParsePool {
  private readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ task: WorkerTaskInput; pending: Pending }> = [];
  private readonly inFlight = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;

  constructor(size: number) {
    this.size = Math.max(1, size);
    for (let i = 0; i < this.size; i += 1) this.spawn();
  }

  private spawn(): void {
    const worker = new Worker(new URL('./parseWorker.js', import.meta.url));
    worker.on('message', (message: { id: number; ok: boolean; error?: string }) => {
      const pending = this.inFlight.get(message.id);
      this.inFlight.delete(message.id);
      if (pending) {
        if (message.ok) pending.resolve(message);
        else pending.reject(new Error(message.error ?? 'worker failed'));
      }
      this.idle.push(worker);
      this.pump();
    });
    worker.on('error', (error) => this.retire(worker, error));
    worker.on('exit', (code) => {
      if (code !== 0 && !this.closed) this.retire(worker, new Error(`worker exited with code ${code}`));
    });
    this.workers.push(worker);
    this.idle.push(worker);
  }

  /** A crashed worker takes its in-flight task down with it; replace the worker. */
  private retire(worker: Worker, error: Error): void {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    for (const [id, pending] of this.inFlight) {
      pending.reject(error);
      this.inFlight.delete(id);
    }
    if (!this.closed) this.spawn();
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const worker = this.idle.pop() as Worker;
      const next = this.queue.shift() as { task: WorkerTaskInput; pending: Pending };
      const id = (this.sequence += 1);
      this.inFlight.set(id, next.pending);
      worker.postMessage({ ...next.task, id });
    }
  }

  run<T>(task: WorkerTaskInput): Promise<T> {
    if (this.closed) return Promise.reject(new Error('pool is closed'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, pending: { resolve: resolve as (value: unknown) => void, reject } });
      this.pump();
    });
  }

  /** Convenience wrapper: every task in parallel, bounded by the pool size. */
  map<T>(tasks: WorkerTaskInput[]): Promise<T[]> {
    return Promise.all(tasks.map((task) => this.run<T>(task)));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.inFlight.values()) pending.reject(new Error('pool closed'));
    this.inFlight.clear();
    this.queue.length = 0;
    await Promise.all(this.workers.map((worker) => worker.terminate().catch(() => undefined)));
    this.workers.length = 0;
    this.idle.length = 0;
  }

  get taskCount(): number {
    return this.inFlight.size + this.queue.length;
  }
}

/**
 * Resolves the worker count from the environment: `WEBLIFT_WORKERS=0` disables the pool
 * (useful when debugging a single file), otherwise it is capped so a scan never starves
 * the API process it runs in.
 */
export function poolSizeFromEnv(): number {
  // Vitest runs the TypeScript sources directly, so a worker cannot resolve the compiled
  // module it imports. The pool is an optimisation: skip it there and cover the
  // in-process path instead.
  if (process.env.VITEST) return 0;

  // Off by default. Measured on a 1 440-file project: in-process 13.2 s, 2 workers
  // 12.7 s, 4 workers 14.3 s, 8 workers 14.6 s. The workload is dominated by per-file
  // I/O plus cloning findings back, so extra workers add contention instead of removing
  // it. Enable deliberately (`WEBLIFT_WORKERS=2`) on a machine where parsing, not I/O,
  // is the bottleneck.
  const raw = process.env.WEBLIFT_WORKERS;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(16, Math.floor(parsed)));
}

export function createParsePool(): ParsePool | null {
  const size = poolSizeFromEnv();
  if (size <= 0) return null;
  try {
    return new ParsePool(size);
  } catch {
    // No worker support (exotic runtime, restricted sandbox): fall back to in-process.
    return null;
  }
}

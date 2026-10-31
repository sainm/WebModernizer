import type { ProjectLockResult, Store } from '../storage/store.js';

export interface LockOwner {
  ownerPid: number;
  acquiredAt: string;
}

export const DEFAULT_LOCK_WAIT_MS = 30_000;

export function defaultLockWaitMs(): number {
  const raw = Number(process.env.WEBLIFT_LOCK_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_LOCK_WAIT_MS;
}

export function projectBusyReason(owner: LockOwner): string {
  return (
    `Another operation is already running on this project (pid ${owner.ownerPid}, since ${owner.acquiredAt}). ` +
    'Wait for it to finish, or stop it if it is stuck.'
  );
}

export interface LockWaitOptions {
  waitMs: number;
  pollMs?: number;
  isCancelled?: () => boolean;
}

export interface LockWaitOutcome {
  result: ProjectLockResult;
  waitedMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export async function acquireProjectLock(
  store: Store,
  projectId: string,
  ownerPid: number,
  token: string,
  options: LockWaitOptions,
): Promise<LockWaitOutcome> {
  const started = Date.now();
  const pollMs = options.pollMs ?? 200;
  let result = store.tryAcquireProjectLock(projectId, ownerPid, token);
  if (result.ok) return { result, waitedMs: 0, timedOut: false, cancelled: false };

  while (Date.now() - started < options.waitMs) {
    if (options.isCancelled?.()) {
      return { result, waitedMs: Date.now() - started, timedOut: false, cancelled: true };
    }
    const remaining = options.waitMs - (Date.now() - started);
    await new Promise((done) => setTimeout(done, Math.min(pollMs, Math.max(1, remaining))));
    if (options.isCancelled?.()) {
      return { result, waitedMs: Date.now() - started, timedOut: false, cancelled: true };
    }
    result = store.tryAcquireProjectLock(projectId, ownerPid, token);
    if (result.ok) return { result, waitedMs: Date.now() - started, timedOut: false, cancelled: false };
  }

  return { result, waitedMs: Date.now() - started, timedOut: true, cancelled: false };
}

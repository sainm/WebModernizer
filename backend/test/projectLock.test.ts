import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';

const DEAD_PID = 2_000_000_000;
const dirs: string[] = [];
const stores: Store[] = [];

function setup(): { dir: string; first: Store; second: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'weblift-lock-'));
  dirs.push(dir);
  const first = new Store({ dataDir: join(dir, 'data') });
  const second = new Store({ dataDir: join(dir, 'data') });
  stores.push(first, second);
  return { dir, first, second };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('project locks', () => {
  it('rejects a second connection while the first owner is alive', () => {
    const { first, second } = setup();
    const acquired = first.tryAcquireProjectLock('prj_1', process.pid, 'token-a');
    expect(acquired.ok).toBe(true);

    const blocked = second.tryAcquireProjectLock('prj_1', process.pid, 'token-b');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.ownerPid).toBe(process.pid);
      expect(blocked.ownerToken).toBe('token-a');
    }

    expect(first.releaseProjectLock('prj_1', 'token-b')).toBe(false);
    expect(first.getProjectLock('prj_1')?.ownerToken).toBe('token-a');

    expect(first.releaseProjectLock('prj_1', 'token-a')).toBe(true);
    const afterRelease = second.tryAcquireProjectLock('prj_1', process.pid, 'token-b');
    expect(afterRelease.ok).toBe(true);
    second.releaseProjectLock('prj_1', 'token-b');
  });

  it('re-enters with the same token', () => {
    const { first } = setup();
    expect(first.tryAcquireProjectLock('prj_1', process.pid, 'same').ok).toBe(true);
    const again = first.tryAcquireProjectLock('prj_1', process.pid, 'same');
    expect(again.ok).toBe(true);
    expect(first.getProjectLock('prj_1')?.ownerToken).toBe('same');
  });

  it('reclaims a lock whose owner process is gone', () => {
    const { first, second } = setup();
    expect(first.tryAcquireProjectLock('prj_1', DEAD_PID, 'dead-token').ok).toBe(true);

    const reclaimed = second.tryAcquireProjectLock('prj_1', process.pid, 'live-token');
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) expect(reclaimed.reclaimed).toBe(true);
    expect(second.getProjectLock('prj_1')?.ownerPid).toBe(process.pid);
    expect(second.getProjectLock('prj_1')?.ownerToken).toBe('live-token');
  });

  it('serves queued tickets strictly in order, even while the lock is free', () => {
    const { first, second } = setup();
    const ticketB = first.enqueueProjectLock('prj_fifo', process.pid, 'b');
    const ticketC = second.enqueueProjectLock('prj_fifo', process.pid, 'c');
    expect(ticketB).toBe(1);
    expect(ticketC).toBe(2);

    const blocked = second.tryAcquireProjectLock('prj_fifo', process.pid, 'c');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.queued).toBe(true);
      expect(blocked.ownerToken).toBe('b');
    }

    expect(first.tryAcquireProjectLock('prj_fifo', process.pid, 'b').ok).toBe(true);
    expect(second.tryAcquireProjectLock('prj_fifo', process.pid, 'c').ok).toBe(false);

    first.releaseProjectLock('prj_fifo', 'b');
    expect(second.tryAcquireProjectLock('prj_fifo', process.pid, 'c').ok).toBe(true);
    expect(second.listProjectLockQueue('prj_fifo')).toHaveLength(0);
    second.releaseProjectLock('prj_fifo', 'c');
  });

  it('does not let a caller without a ticket jump a live waiter', () => {
    const { first } = setup();
    first.enqueueProjectLock('prj_jump', process.pid, 'waiter');
    const jumped = first.tryAcquireProjectLock('prj_jump', process.pid, 'no-ticket');
    expect(jumped.ok).toBe(false);
    if (!jumped.ok) expect(jumped.queued).toBe(true);

    expect(first.tryAcquireProjectLock('prj_jump', process.pid, 'waiter').ok).toBe(true);
    first.releaseProjectLock('prj_jump', 'waiter');
  });

  it('drops dead waiters before serving the next ticket', () => {
    const { first } = setup();
    first.enqueueProjectLock('prj_dead', DEAD_PID, 'dead-waiter');
    first.enqueueProjectLock('prj_dead', process.pid, 'live');
    expect(first.listProjectLockQueue('prj_dead').map((entry) => entry.token)).toEqual(['live']);

    expect(first.tryAcquireProjectLock('prj_dead', process.pid, 'live').ok).toBe(true);
    expect(first.listProjectLockQueue('prj_dead')).toHaveLength(0);
    first.releaseProjectLock('prj_dead', 'live');
  });
});

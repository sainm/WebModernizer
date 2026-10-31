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
});

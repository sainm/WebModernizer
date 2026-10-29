import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type ServerContext } from '../src/server/index.js';

/**
 * First HTTP-level tests for the API. Every other suite calls the services directly, which is why
 * the CORS, SSE and encoding defects of the last review all lived in this layer.
 */

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '../../examples/legacy-app');

let server: Server;
let context: ServerContext;
let base: string;
let dir: string;
let scanId: string;

const TERMINAL = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'weblift-http-'));
  const started = startServer({ port: 0, dataDir: join(dir, 'data') });
  server = started.server;
  context = started.context;
  await new Promise<void>((done) => server.once('listening', () => done()));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('server did not bind');
  base = `http://127.0.0.1:${address.port}`;

  const project = await json<{ id: string }>(
    await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'HTTP test', rootPath: exampleRoot }),
    }),
  );
  const scan = await json<{ id: string }>(await fetch(`${base}/api/projects/${project.id}/scans`, { method: 'POST' }));
  scanId = scan.id;
  for (let i = 0; i < 300; i += 1) {
    const state = await json<{ status: string }>(await fetch(`${base}/api/scans/${scanId}`));
    if (TERMINAL.includes(state.status)) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('scan did not finish');
}, 60000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  context.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('api surface', () => {
  it('reports health and rule metadata', async () => {
    const health = await json<{ ok: boolean; rules: number }>(await fetch(`${base}/api/health`));
    expect(health.ok).toBe(true);
    expect(health.rules).toBeGreaterThan(40);

    const meta = await json<{ ruleSignature: string }>(await fetch(`${base}/api/meta`));
    expect(meta.ruleSignature).toMatch(/@/);

    // The API can rewrite project files, so it must not be reachable from the network by default.
    const address = server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
  });

  it('returns findings with locations and evidence', async () => {
    const result = await json<{ total: number; items: Array<{ startLine: number; startColumn: number; ruleId: string; module: string }> }>(
      await fetch(`${base}/api/scans/${scanId}/findings?limit=500`),
    );
    expect(result.total).toBeGreaterThan(80);
    for (const finding of result.items) {
      expect(finding.startLine).toBeGreaterThan(0);
      expect(finding.startColumn).toBeGreaterThan(0);
      expect(finding.ruleId).toMatch(/^WL-/);
      expect(typeof finding.module).toBe('string');
    }
  });

  it('serves a Shift_JIS file decoded, and marks it unchanged', async () => {
    const files = await json<{ items: Array<{ path: string; encoding: string }> }>(
      await fetch(`${base}/api/scans/${scanId}/files`),
    );
    const target = files.items.find((file) => file.path === 'js/shift-jis-helper.js');
    expect(target?.encoding).toBe('shift_jis');

    const source = await json<{ content: string; stale: boolean; encoding: string }>(
      await fetch(`${base}/api/scans/${scanId}/files/source?path=${encodeURIComponent(target?.path ?? '')}`),
    );
    expect(source.encoding).toBe('shift_jis');
    // Mojibake here would mean the viewer fell back to UTF-8 for a file it decoded correctly.
    expect(source.content.includes('\uFFFD')).toBe(false);
    expect(source.stale).toBe(false);
  });

  it('refuses to read a file outside the scanned set', async () => {
    const res = await fetch(`${base}/api/scans/${scanId}/files/source?path=${encodeURIComponent('../../etc/passwd')}`);
    expect(res.status).toBe(403);
  });
});

describe('cross-origin policy', () => {
  it('does not grant a remote page access to scan data', async () => {
    const res = await fetch(`${base}/api/scans`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects a write from a remote page', async () => {
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'pwned', rootPath: '/' }),
    });
    expect(res.status).toBe(403);
  });

  it('keeps the Vite dev origin working', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { origin: 'http://localhost:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toContain('Origin');
  });
});

describe('scan event stream', () => {
  it('closes a finished scan instead of holding the connection open', async () => {
    const started = Date.now();
    const res = await fetch(`${base}/api/scans/${scanId}/events`);
    const text = await res.text();
    expect(Date.now() - started).toBeLessThan(2000);

    const events = text
      .split('\n\n')
      .map((chunk) => chunk.replace(/^data: /, '').trim())
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk) as { type: string; status?: string });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect(events[0].status).toBe('COMPLETED');
  });
});

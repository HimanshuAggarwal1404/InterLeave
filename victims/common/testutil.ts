// Test helpers shared by the victim tests. Not a test file itself.
import http from 'node:http';
import type net from 'node:net';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import type pg from 'pg';
import { newPool } from './kit.ts';
import { DIRECT_DSN } from './main.ts';
import { onCleanup } from '../../src/testutil/cleanup.ts';

// testPool connects straight to Postgres (INTERLEAVE_TEST_DSN, or the local
// interleave database), or marks the test skipped and returns undefined.
export async function testPool(t: TestContext): Promise<pg.Pool | undefined> {
  const pool = newPool(process.env['INTERLEAVE_TEST_DSN'] ?? DIRECT_DSN);
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end();
    t.skip(`Postgres not reachable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  onCleanup(t, () => pool.end());
  return pool;
}

// resetDB runs a victim's seed.sql (pass new URL('./seed.sql', import.meta.url)).
export async function resetDB(pool: pg.Pool, seed: URL): Promise<void> {
  await pool.query(await readFile(seed, 'utf8'));
}

// startServer runs handler on a random local port until the test ends.
export async function startServer(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  onCleanup(t, async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

// post sends one JSON request and returns its status and body.
export function post(url: string, body: unknown, options: { tag?: string; method?: string } = {}): Promise<{ status: number; body: string }> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.tag !== undefined) {
    headers['X-Interleave-Req'] = options.tag;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? 'POST', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').trim() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

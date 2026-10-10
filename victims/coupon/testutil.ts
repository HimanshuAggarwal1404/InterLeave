// Test helpers shared by the coupon tests and the kill test. Not a test file itself.
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import type pg from 'pg';
import { DIRECT_DSN, newPool } from './app.ts';
import { PgProxy, type OnQuery } from '../../src/proxy/index.ts';
import { onCleanup } from '../../src/testutil/cleanup.ts';

// testPool connects to the interleave database directly (port 5432, bypassing
// the proxy). Set INTERLEAVE_TEST_DSN to use a different database. It returns
// undefined, after marking the test skipped, if Postgres is not reachable:
// callers must then return, because t.skip() alone does not stop a test.
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

// resetDB runs seed.sql so every round starts from the same state.
export async function resetDB(pool: pg.Pool): Promise<void> {
  const seed = await readFile(new URL('./seed.sql', import.meta.url), 'utf8');
  await pool.query(seed);
}

// readCoupon returns the coupon's use count, its limit, and how many
// redemption rows exist: the invariant is uses <= max_uses.
export async function readCoupon(pool: pg.Pool): Promise<{ uses: number; maxUses: number; redemptions: number }> {
  const { rows } = await pool.query<{ uses: number; max_uses: number; redemptions: number }>(`SELECT uses, max_uses,
    (SELECT count(*)::int FROM redemptions WHERE code = 'DIWALI50') AS redemptions
    FROM coupons WHERE code = 'DIWALI50'`);
  return { uses: rows[0].uses, maxUses: rows[0].max_uses, redemptions: rows[0].redemptions };
}

// openServer runs handler on a random local port and returns its base URL
// and a close function. startServer does the same until the test ends.
export async function openServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const close = async () => {
    server.closeAllConnections(); // close() alone would wait for idle keep-alive connections
    await new Promise((r) => server.close(r));
  };
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close };
}

export async function startServer(t: TestContext, handler: http.RequestListener): Promise<string> {
  const { url, close } = await openServer(handler);
  onCleanup(t, close);
  return url;
}

// post sends one redeem request and returns the HTTP status and body. tag
// becomes the X-Interleave-Req header ("" for none). Each request uses its own
// connection (agent: false), so no idle connection keeps the test alive.
export function post(
  baseURL: string,
  options: { tag?: string; body?: string; method?: string; path?: string } = {},
): Promise<{ status: number; body: string }> {
  const body = options.body ?? JSON.stringify({ code: 'DIWALI50', user_id: 1 });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.tag !== undefined && options.tag !== '') {
    headers['X-Interleave-Req'] = options.tag;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseURL}${options.path ?? '/redeem'}`,
      { method: options.method ?? 'POST', headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// openPoolViaProxy starts an in-process Interleave proxy in front of the
// local Postgres, with hook as its onQuery, and returns a pool through it and
// a close function (pool first, then the proxy). poolViaProxy does the same
// until the test ends.
export async function openPoolViaProxy(hook: OnQuery): Promise<{ pool: pg.Pool; close: () => Promise<void> }> {
  const p = new PgProxy('127.0.0.1:5432');
  p.onQuery = hook;
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const ctl = new AbortController();
  const served = p.serve(server, ctl.signal);
  const port = (server.address() as net.AddressInfo).port;
  const pool = newPool(DIRECT_DSN.replace('127.0.0.1:5432', `127.0.0.1:${port}`));
  const close = async () => {
    await pool.end();
    ctl.abort();
    await served;
  };
  return { pool, close };
}

export async function poolViaProxy(t: TestContext, hook: OnQuery): Promise<pg.Pool> {
  const { pool, close } = await openPoolViaProxy(hook);
  onCleanup(t, close);
  return pool;
}

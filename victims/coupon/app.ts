// The coupon victim: a deliberately racy app for Interleave.
//
// POST /redeem {"code": "DIWALI50", "user_id": 1} redeems a coupon if it has
// uses left. It checks the count with a plain SELECT and then increments it in
// a separate statement (check-then-act). BEGIN does not make this safe: under
// READ COMMITTED (the Postgres default) a plain SELECT takes no lock, so two
// concurrent requests can both see uses = 0 and both redeem a single-use coupon.
// --fixed locks the row during the check (SELECT ... FOR UPDATE), which is correct.
import type http from 'node:http';
import pg from 'pg';
import { escapeLiteral } from 'pg';

// PROXY_DSN goes through Interleave (the default). DIRECT_DSN bypasses it.
// 127.0.0.1 rather than localhost: Node may resolve localhost to ::1, while
// the proxy listens on 127.0.0.1 only.
export const PROXY_DSN = 'postgres://interleave:interleave@127.0.0.1:6433/interleave?sslmode=disable';
export const DIRECT_DSN = 'postgres://interleave:interleave@127.0.0.1:5432/interleave?sslmode=disable';

export type RedeemRequest = { code: string; userId: number };

// newPool returns a connection pool for dsn. A pool emits 'error' when an idle
// connection breaks (Postgres restarted, the proxy stopped); without a
// listener that event would crash the app.
export function newPool(dsn: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: dsn });
  pool.on('error', (err) => console.error(`pool: idle connection failed: ${err.message}`));
  return pool;
}

// newHandler returns the app's request handler. It does not start a server,
// so tests can run it on a random port.
export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return (req, res) => {
    // The handler is async; catch everything so a failure becomes a 500
    // instead of an unhandled rejection that would stop the process.
    handle(pool, fixed, req, res).catch((err: unknown) => {
      console.error(`redeem: ${String(err)}`);
      if (!res.headersSent) {
        reply(res, 500, 'internal error');
      }
    });
  };
}

async function handle(pool: pg.Pool, fixed: boolean, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== '/redeem') {
    reply(res, 404, '404 page not found');
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    reply(res, 405, 'Method Not Allowed');
    return;
  }
  // Interleave names each request it fires (A, B, ...). The tag goes into
  // SQL, so anything but a plain tag is refused (no SQL injection).
  // Node joins repeated headers into one value ("A, B"), which then fails
  // validTag, so a request with two tags is refused. (The array case is only
  // there because Node's types allow it.)
  const header = req.headers['x-interleave-req'];
  const tag = Array.isArray(header) ? header[0] : (header ?? '');
  if (tag !== '' && !validTag(tag)) {
    reply(res, 400, 'invalid X-Interleave-Req header');
    return;
  }
  const body = parseRedeemBody(await readBody(req));
  if (body === undefined) {
    reply(res, 400, 'invalid JSON body');
    return;
  }
  const [status, msg] = await redeem(pool, tagComment(tag), fixed, body);
  reply(res, status, msg);
}

// redeem returns the HTTP status and message for one redemption attempt.
// tc is the Interleave tag comment that starts every statement ("" if none).
// fixed selects the correct implementation (--fixed).
//
// Every statement is sent as plain text, with no values array: node-postgres
// then uses the simple query protocol (one 'Q' message per statement), which
// is what Interleave schedules (D-003). Values are inlined safely: strings
// through escapeLiteral, numbers only after checking they are integers.
export async function redeem(pool: pg.Pool, tc: string, fixed: boolean, req: RedeemRequest): Promise<[number, string]> {
  const client = await pool.connect();
  let committed = false;
  let broken: Error | undefined;
  try {
    // The app sends BEGIN, COMMIT and ROLLBACK itself, so all of them carry
    // the tag and are scheduled like any other statement (D-021).
    await client.query(tc + 'BEGIN');

    // Check.
    let check = `SELECT uses, max_uses FROM coupons WHERE code = ${sqlText(req.code)}`;
    if (fixed) {
      // THE FIX: lock the row while checking. A concurrent redeem's check now
      // waits until we commit, then reads the new count and is refused.
      check += ' FOR UPDATE';
    }
    const { rows } = await client.query<{ uses: number; max_uses: number }>(tc + check);
    if (rows.length === 0) {
      return [404, 'unknown coupon'];
    }
    if (rows[0].uses >= rows[0].max_uses) {
      return [409, 'coupon already used up'];
    }

    // Act. THE BUG: another request may have redeemed the coupon since our
    // SELECT, but we go ahead because our (now stale) check passed.
    await client.query(tc + `UPDATE coupons SET uses = uses + 1 WHERE code = ${sqlText(req.code)}`);
    await client.query(tc + `INSERT INTO redemptions (code, user_id) VALUES (${sqlText(req.code)}, ${sqlInt(req.userId)})`);
    await client.query(tc + 'COMMIT');
    committed = true;
    return [200, 'redeemed'];
  } catch (err) {
    console.error(`redeem: ${err instanceof Error ? err.message : String(err)}`);
    return [500, 'internal error'];
  } finally {
    // Like Go's `defer tx.Rollback()`: on every path except a successful
    // COMMIT, end the transaction before the response goes out.
    if (!committed) {
      try {
        await client.query(tc + 'ROLLBACK');
      } catch (err) {
        broken = err instanceof Error ? err : new Error(String(err));
      }
    }
    client.release(broken); // a connection whose ROLLBACK failed is closed, not reused
  }
}

// sqlText returns s as a quoted SQL string literal, escaped by node-postgres.
export function sqlText(s: string): string {
  return escapeLiteral(s);
}

// sqlInt returns n as SQL, refusing anything but a safe integer, so only
// digits (and a minus sign) can ever reach the SQL text.
export function sqlInt(n: number): string {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`not an integer: ${n}`);
  }
  return String(n);
}

// parseRedeemBody validates the JSON body: an object whose "code" is a string
// and whose "user_id" is an integer. Missing fields default to "" and 0.
// It returns undefined for anything else.
export function parseRedeemBody(text: string): RedeemRequest | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return undefined;
  }
  const o = v as Record<string, unknown>;
  const code = o['code'] ?? '';
  const userId = o['user_id'] ?? 0;
  if (typeof code !== 'string' || typeof userId !== 'number' || !Number.isSafeInteger(userId)) {
    return undefined;
  }
  return { code, userId };
}

// tagComment returns the SQL comment that tells Interleave which request a
// statement belongs to, e.g. "/* il:req=A */ ", or "" without a tag.
export function tagComment(tag: string): string {
  return tag === '' ? '' : `/* il:req=${tag} */ `;
}

// validTag accepts the tags Interleave uses: 1-64 of A-Z a-z 0-9 _ -.
// (A copy of Interleave's rule: the victim is a standalone app and does not
// import Interleave's code.)
export function validTag(tag: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(tag);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function reply(res: http.ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg + '\n');
}

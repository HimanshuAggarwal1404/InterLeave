// Shared plumbing for the victim apps (inventory, seat, wallet, username,
// transfer, approval, counter): the HTTP endpoint, the request tag, safe SQL
// values, and tagged transactions. Each victim's app.ts then holds only its
// race and its fix. (The coupon victim is the original, self-contained
// example; these follow the same rules.)
//
// Victims are standalone apps: they do not import Interleave's code.
import type http from 'node:http';
import pg from 'pg';
import { escapeLiteral } from 'pg';

// Reply is the HTTP status and message an endpoint answers with.
export type Reply = [status: number, message: string];

// BadRequest is thrown for an invalid body field; the endpoint answers 400.
export class BadRequest extends Error {}

// newPool returns a connection pool. A pool emits 'error' when an idle
// connection breaks (Postgres restarted, the proxy stopped); without a
// listener that would crash the app.
export function newPool(dsn: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: dsn });
  pool.on('error', (err) => console.error(`pool: idle connection failed: ${err.message}`));
  return pool;
}

// endpoint returns a request handler for POST <path> with a JSON object body.
// It answers 404/405 for other paths/methods, refuses a bad X-Interleave-Req
// header with 400 before any SQL (the tag is pasted into SQL), and turns any
// unexpected failure into a 500.
export function endpoint(path: string, handle: (body: Record<string, unknown>, tc: string) => Promise<Reply>): http.RequestListener {
  return (req, res) => {
    respond(req, res).catch((err: unknown) => {
      console.error(`${path}: ${String(err)}`);
      if (!res.headersSent) {
        reply(res, [500, 'internal error']);
      }
    });
  };

  async function respond(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== path) {
      reply(res, [404, '404 page not found']);
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      reply(res, [405, 'Method Not Allowed']);
      return;
    }
    const header = req.headers['x-interleave-req'];
    const tag = Array.isArray(header) ? header[0] : (header ?? '');
    if (tag !== '' && !validTag(tag)) {
      reply(res, [400, 'invalid X-Interleave-Req header']);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      reply(res, [400, 'invalid JSON body']);
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      reply(res, [400, 'invalid JSON body']);
      return;
    }
    try {
      reply(res, await handle(body as Record<string, unknown>, tagComment(tag)));
    } catch (err) {
      if (err instanceof BadRequest) {
        reply(res, [400, err.message]);
        return;
      }
      throw err;
    }
  }
}

function reply(res: http.ServerResponse, [status, message]: Reply): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message + '\n');
}

// text and int read a body field, or throw BadRequest.
export function text(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || v === '') {
    throw new BadRequest(`${field}: want a non-empty string`);
  }
  return v;
}

export function int(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new BadRequest(`${field}: want an integer`);
  }
  return v;
}

// sqlText and sqlInt put a value into SQL text safely. Victims never pass a
// values array: node-postgres would then use the extended protocol, which
// Interleave does not schedule (D-003).
export function sqlText(s: string): string {
  return escapeLiteral(s);
}

export function sqlInt(n: number): string {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`not an integer: ${n}`);
  }
  return String(n);
}

// tagComment returns "/* il:req=A */ " for tag A, or "" without a tag.
export function tagComment(tag: string): string {
  return tag === '' ? '' : `/* il:req=${tag} */ `;
}

// validTag accepts 1-64 of A-Z a-z 0-9 _ - (Interleave's tag rule).
export function validTag(tag: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(tag);
}

// Query runs one SQL statement inside a transaction, with the request's tag.
export type Query = <R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string) => Promise<pg.QueryResult<R>>;

// transaction runs work inside BEGIN ... COMMIT on one pooled connection,
// with every statement (BEGIN, COMMIT and ROLLBACK included) tagged (D-021).
// It commits when work answers 2xx and rolls back otherwise, before replying,
// like a Go `defer tx.Rollback()`. Errors from work are rethrown after the
// rollback, so callers can retry (the wallet fix does).
export async function transaction(
  pool: pg.Pool,
  tc: string,
  work: (q: Query) => Promise<Reply>,
  isolation?: 'SERIALIZABLE',
): Promise<Reply> {
  const client = await pool.connect();
  let committed = false;
  let broken: Error | undefined;
  const q: Query = (sql) => client.query(tc + sql);
  try {
    await q(isolation === undefined ? 'BEGIN' : `BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await work(q);
    if (result[0] >= 200 && result[0] < 300) {
      await q('COMMIT');
      committed = true;
    }
    return result;
  } finally {
    if (!committed) {
      try {
        await q('ROLLBACK');
      } catch (err) {
        broken = err instanceof Error ? err : new Error(String(err));
      }
    }
    client.release(broken); // a connection whose ROLLBACK failed is closed, not reused
  }
}

// sqlState returns the SQLSTATE code of a Postgres error, if it is one.
export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

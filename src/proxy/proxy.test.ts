import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import type { ReadyStatus } from '../pgwire/index.ts';
import { PgProxy, type DoneFn } from './proxy.ts';
import {
  TestConn,
  authOKReady,
  cancelRequest,
  commandComplete,
  dial,
  fakeUpstream,
  listen,
  openHandles,
  query,
  queryMsg,
  readyIdle,
  readyInTx,
  serveProxy,
  sslRequest,
  startProxy,
  startupMsg,
  terminate,
  waitUntil,
  withTimeout,
} from './testutil.ts';
import { bytes } from '../testutil/bytes.ts';

test('NewOnlyAllowsLocalUpstream', async (t) => {
  const cases: Array<[upstream: string, ok: boolean]> = [
    ['localhost:5432', true],
    ['127.0.0.1:5432', true],
    ['[::1]:5432', true],
    ['db.example.com:5432', false],
    ['10.0.0.5:5432', false],
    [':5432', false], // empty host: say "localhost" explicitly
    ['localhost', false], // no port
    // Beyond the Go cases: the whole 127.0.0.0/8 block and other spellings of ::1 are loopback too.
    ['127.0.0.2:5432', true],
    ['[0:0:0:0:0:0:0:1]:5432', true],
    ['[::ffff:127.0.0.1]:5432', true],
    ['localhost:abc', false], // port is not a number
    ['[::1]', false], // no port
  ];
  for (const [upstream, ok] of cases) {
    await t.test(upstream, () => {
      if (ok) {
        assert.doesNotThrow(() => new PgProxy(upstream));
      } else {
        assert.throws(() => new PgProxy(upstream));
      }
    });
  }
});

// expectStartup checks the fake Postgres received exactly the startup we sent.
async function expectStartup(server: TestConn, want: Buffer): Promise<void> {
  await server.expectBytes(want);
}

// Full conversation against a fake Postgres, checking every byte the proxy forwards.
test('PassThroughFakeUpstream', async (t) => {
  const upstream = await fakeUpstream(t);
  const client = await dial(t, await startProxy(t, upstream.addr));

  // SSLRequest is answered by the proxy itself with 'N'; Postgres never sees it.
  client.write(sslRequest);
  await client.expectBytes(bytes('N'));

  // The StartupMessage is forwarded unchanged.
  client.write(startupMsg);
  const server = await upstream.accepted();
  await expectStartup(server, startupMsg);

  // Postgres → app.
  server.write(authOKReady);
  await client.expectBytes(authOKReady);

  // App → Postgres.
  client.write(query);
  await server.expectBytes(query);

  // App says goodbye and hangs up: Postgres sees Terminate, then the proxy closes it too.
  client.write(terminate);
  client.socket.end();
  await server.expectBytes(terminate);
  await server.expectEOF();
});

// connectedClient runs the startup phase through p against a fake Postgres
// and returns both ends, ready for queries.
async function connectedClient(t: TestContext, p: PgProxy, upstream: Awaited<ReturnType<typeof fakeUpstream>>) {
  const client = await dial(t, await serveProxy(t, p));
  client.write(startupMsg);
  const server = await upstream.accepted();
  await expectStartup(server, startupMsg);
  server.write(authOKReady);
  await client.expectBytes(authOKReady);
  return { client, server };
}

// onQuery sees every Query with its request tag, before the query is
// forwarded, and the query still reaches Postgres byte for byte.
test('OnQueryReportsTags', async (t) => {
  const seen: Array<{ tag: string; sql: string }> = [];
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  p.onQuery = (_signal, tag, sql) => {
    seen.push({ tag, sql });
    return undefined;
  };
  const { client, server } = await connectedClient(t, p, upstream);

  const cases: Array<{ raw: Buffer; want: { tag: string; sql: string } }> = [
    { raw: queryMsg('/* il:req=A */ SELECT 1'), want: { tag: 'A', sql: '/* il:req=A */ SELECT 1' } },
    { raw: query, want: { tag: '', sql: 'SELECT 1' } },
    // A broken tag is logged and treated as untagged; the query still goes through.
    { raw: queryMsg('/* il:req=A;B */ SELECT 1'), want: { tag: '', sql: '/* il:req=A;B */ SELECT 1' } },
  ];
  for (const tt of cases) {
    client.write(tt.raw);
    await server.expectBytes(tt.raw);
    // By the time Postgres has the query, onQuery must already have seen it.
    assert.deepEqual(seen.shift(), tt.want, `onQuery was not called before ${tt.want.sql} was forwarded`);
  }

  // Other messages (here Terminate) are not queries.
  client.write(terminate);
  await server.expectBytes(terminate);
  assert.deepEqual(seen, [], 'onQuery called for a non-Query message');
});

// Parking = an unresolved Promise: while onQuery's Promise is pending the
// query must not reach Postgres; once it resolves, it goes through.
test('OnQueryAsyncHookParks', async (t) => {
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  let release: (() => void) | undefined;
  let called = false;
  p.onQuery = (signal) => {
    called = true;
    // Released by the test, or by the abort (the hook contract: a parked
    // onQuery must settle when its signal aborts).
    return new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
  };
  const { client, server } = await connectedClient(t, p, upstream);

  const q = queryMsg('/* il:req=A */ SELECT 1');
  client.write(q);
  await waitUntil(() => called, 'onQuery was never called');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.socket.bytesRead, startupMsg.length, 'the query reached Postgres while it was parked');

  release?.();
  await server.expectBytes(q);
});

// Each query's done is called with the status of that query's own
// ReadyForQuery (FR-5). The ReadyForQuery that ends startup belongs to no
// query, and a query whose onQuery returned undefined still uses up its reply.
test('DoneGetsEachQuerysReadyStatus', async (t) => {
  const finishes: Array<{ sql: string; status: ReadyStatus }> = [];
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  p.onQuery = (_signal, tag, sql): DoneFn | undefined => {
    if (tag === '') {
      return undefined; // like the scheduler: untagged queries are not steps (D-016)
    }
    return (status) => finishes.push({ sql, status });
  };
  const { client, server } = await connectedClient(t, p, upstream);
  assert.deepEqual(finishes, [], "the startup's ReadyForQuery must not call any done");

  const steps: Array<{ sql: string; reply: Buffer; finish?: { sql: string; status: ReadyStatus } }> = [
    { sql: '/* il:req=A */ BEGIN', reply: bytes(commandComplete, readyInTx), finish: { sql: '/* il:req=A */ BEGIN', status: 'T' } },
    { sql: 'SELECT 1', reply: bytes(commandComplete, readyInTx) },
    { sql: '/* il:req=A */ COMMIT', reply: bytes(commandComplete, readyIdle), finish: { sql: '/* il:req=A */ COMMIT', status: 'I' } },
  ];
  for (const s of steps) {
    client.write(queryMsg(s.sql));
    await server.expectBytes(queryMsg(s.sql));
    server.write(s.reply);
    await client.expectBytes(s.reply);
    // done runs right after the reply is written to the app, before we read it.
    assert.deepEqual(finishes.shift(), s.finish, `done for ${s.sql}`);
  }

  // Two queries sent before either reply (pipelining): the first reply
  // belongs to the untagged query, so B's done must get the second status.
  const untagged = queryMsg('SELECT 1');
  const tagged = queryMsg('/* il:req=B */ SELECT 2');
  client.write(bytes(untagged, tagged));
  await server.expectBytes(bytes(untagged, tagged));
  const replies = bytes(commandComplete, readyInTx, commandComplete, readyIdle);
  server.write(replies);
  await client.expectBytes(replies);
  assert.deepEqual(finishes, [{ sql: '/* il:req=B */ SELECT 2', status: 'I' }], 'pipelined: B must get the second status, once');
});

// parkingHook parks every query until its signal aborts, and records the abort.
function parkingHook(): { hook: PgProxy['onQuery']; state: { parked: number; aborted: number } } {
  const state = { parked: 0, aborted: 0 };
  const hook = (signal: AbortSignal) => {
    state.parked++;
    return new Promise<undefined>((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          state.aborted++;
          resolve(undefined);
        },
        { once: true },
      ),
    );
  };
  return { hook, state };
}

// If the app's connection dies (here: reset) while one of its queries is
// parked, the hook's signal must abort so the scheduler hears about it. The
// app→postgres pump is stuck in the hook and does not read, so the proxy has
// to notice the socket closing by itself.
test('AppResetReleasesParkedQuery', async (t) => {
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  const { hook, state } = parkingHook();
  p.onQuery = hook;
  const { client } = await connectedClient(t, p, upstream);

  client.write(queryMsg('/* il:req=A */ SELECT 1'));
  await waitUntil(() => state.parked === 1, 'onQuery was never called');
  client.socket.resetAndDestroy();
  await waitUntil(() => state.aborted === 1, "the parked query's signal did not abort after the app reset its connection");
});

// The same while a reply is on its way: Q1 is released, Q2 parked, the app
// resets, then Postgres answers Q1. Writing that reply to the dead socket must
// not leave the postgres→app pump waiting forever for 'drain' (a destroyed
// socket never emits it), and Q2 must still be released.
test('AppResetWhileReplyPendingReleasesParkedQuery', async (t) => {
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  let calls = 0;
  let aborted = false;
  p.onQuery = (signal) => {
    calls++;
    if (calls === 1) {
      return () => {}; // Q1 runs at once
    }
    return new Promise<undefined>((resolve) =>
      signal.addEventListener('abort', () => ((aborted = true), resolve(undefined)), { once: true }),
    );
  };
  const { client, server } = await connectedClient(t, p, upstream);

  const q1 = queryMsg('/* il:req=A */ SELECT 1');
  const q2 = queryMsg('/* il:req=A */ SELECT 2');
  client.write(bytes(q1, q2));
  await server.expectBytes(q1);
  await waitUntil(() => calls === 2, 'Q2 never reached onQuery');
  client.socket.resetAndDestroy();
  await new Promise((r) => setTimeout(r, 50)); // let the proxy see the reset
  server.write(bytes(commandComplete, readyIdle));
  await waitUntil(() => aborted, "Q2's signal did not abort after the app reset its connection");
});

// A hook that throws (or rejects) while the connection is open is a bug in
// the hook, not in the query: the error is logged and the query is forwarded
// unscheduled, with a placeholder slot so later replies still pair correctly.
test('OnQueryFailureForwardsUnscheduled', async (t) => {
  const finishes: Array<{ sql: string; status: ReadyStatus }> = [];
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  p.onQuery = (_signal, _tag, sql) => {
    if (sql.endsWith('throws')) {
      throw new Error('hook bug');
    }
    if (sql.endsWith('rejects')) {
      return Promise.reject(new Error('hook bug'));
    }
    return (status) => finishes.push({ sql, status });
  };
  const { client, server } = await connectedClient(t, p, upstream);

  const steps: Array<[sql: string, reply: Buffer]> = [
    ['/* il:req=A */ SELECT 1 -- throws', bytes(commandComplete, readyInTx)],
    ['/* il:req=A */ SELECT 1 -- rejects', bytes(commandComplete, readyInTx)],
    ['/* il:req=A */ SELECT 2', bytes(commandComplete, readyIdle)],
  ];
  for (const [sql, reply] of steps) {
    client.write(queryMsg(sql));
    await server.expectBytes(queryMsg(sql)); // forwarded despite the failing hook
    server.write(reply);
    await client.expectBytes(reply);
  }
  assert.deepEqual(finishes, [{ sql: '/* il:req=A */ SELECT 2', status: 'I' }], 'only the last query has a done, with its own status');
});

// Every Sync ('S', extended protocol) and FunctionCall ('F') also gets exactly
// one ReadyForQuery. If an app pipelines a Sync ahead of a Query, the Sync's
// ReadyForQuery must not be credited to the Query.
test('SyncTakesAPendingSlot', async (t) => {
  const finishes: ReadyStatus[] = [];
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  p.onQuery = (_signal, tag) => (tag === '' ? undefined : (status) => finishes.push(status));
  const { client, server } = await connectedClient(t, p, upstream);

  const sync = bytes('S', [0x00, 0x00, 0x00, 0x04]);
  const tagged = queryMsg('/* il:req=A */ SELECT 1');
  client.write(bytes(sync, tagged));
  await server.expectBytes(bytes(sync, tagged));
  // Postgres answers the Sync (Z 'T'), then the Query (C, Z 'I').
  const replies = bytes(readyInTx, commandComplete, readyIdle);
  server.write(replies);
  await client.expectBytes(replies);
  assert.deepEqual(finishes, ['I'], "the Query's done must get its own status, not the Sync's");
});

// A parked query waits inside onQuery. Shutting the proxy down must abort
// onQuery's signal so the query gives up, or serve() could never finish.
test('ShutdownReleasesParkedQuery', async (t) => {
  const before = openHandles();
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  let parked = false;
  p.onQuery = (signal) => {
    parked = true;
    // Never released: only the abort ends the wait.
    return new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
  };
  const server = net.createServer();
  const ctl = new AbortController();
  const served = p.serve(server, ctl.signal);
  const addr = await listen(server);

  const client = await dial(t, addr);
  client.write(startupMsg);
  const pgSide = await upstream.accepted();
  await expectStartup(pgSide, startupMsg);
  client.write(queryMsg('/* il:req=A */ SELECT 1'));
  await waitUntil(() => parked, 'onQuery was never called');

  ctl.abort();
  await withTimeout(served, 'serve did not settle within 5s of abort while a query was parked');
  await client.expectEOF();
  await assertNoLeaks(before, [client, pgSide], upstream);
});

// If Postgres hangs up (e.g. it was restarted), the app's connection must close too.
test('UpstreamCloseClosesClient', async (t) => {
  const upstream = await fakeUpstream(t);
  const client = await dial(t, await startProxy(t, upstream.addr));
  client.write(startupMsg);
  const server = await upstream.accepted();
  await expectStartup(server, startupMsg);
  await server.close();
  await client.expectEOF();
});

// A CancelRequest arrives on its own new connection: forward it, then hang up.
test('CancelRequestForwarded', async (t) => {
  const upstream = await fakeUpstream(t);
  const client = await dial(t, await startProxy(t, upstream.addr));
  client.write(cancelRequest);
  const server = await upstream.accepted();
  await server.expectBytes(cancelRequest);
  await server.expectEOF();
  await client.expectEOF();
});

// If Postgres is not reachable, the app's connection is closed rather than left hanging.
test('UpstreamUnreachable', async (t) => {
  // Grab a free port, then close it so nothing is listening there.
  const tmp = net.createServer();
  const deadAddr = await listen(tmp);
  await new Promise((r) => tmp.close(r));

  const client = await dial(t, await startProxy(t, deadAddr));
  client.write(startupMsg);
  await client.expectEOF();
});

// Shutting the proxy down while an app is connected must close that
// connection and let serve() settle, leaving no socket or timer behind.
test('ShutdownClosesOpenConnections', async (t) => {
  const before = openHandles();
  const upstream = await fakeUpstream(t);
  const p = new PgProxy(upstream.addr);
  const server = net.createServer();
  const ctl = new AbortController();
  const served = p.serve(server, ctl.signal);
  const addr = await listen(server);

  const client = await dial(t, addr);
  client.write(startupMsg);
  const pgSide = await upstream.accepted();
  await expectStartup(pgSide, startupMsg);

  ctl.abort();
  await withTimeout(served, 'serve did not settle within 5s of abort');
  await client.expectEOF();
  await pgSide.expectEOF();
  await assertNoLeaks(before, [client, pgSide], upstream);
});

// The real thing: node-postgres talks to the local Postgres 18 through the
// proxy, with SCRAM authentication, several connections at once, and a transaction.
test('RealPostgres', async (t) => {
  const upstream = '127.0.0.1:5432';
  if (!(await reachable(upstream))) {
    t.skip(`Postgres not reachable at ${upstream}`);
    return;
  }
  const addr = await startProxy(t, upstream);

  // pg never sends an SSLRequest with sslmode=disable.
  await t.test('sslmode=disable (node-postgres)', async () => {
    const pool = new pg.Pool({
      connectionString: `postgres://interleave:interleave@${addr}/interleave?sslmode=disable`,
      max: 5,
      connectionTimeoutMillis: 5000,
    });
    try {
      // 20 concurrent queries over up to 5 connections. The number is written
      // into the SQL (no values array) so pg uses the simple protocol.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => pool.query<{ db: string; n: number }>(`SELECT current_database() AS db, ${i} + 1 AS n`)),
      );
      results.forEach((r, i) => assert.deepEqual(r.rows[0], { db: 'interleave', n: i + 1 }, `query ${i}`));

      // A transaction, like the coupon app's (temp table: nothing persists).
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('CREATE TEMP TABLE t (n int) ON COMMIT DROP');
        await c.query('INSERT INTO t VALUES (1), (2)');
        const sum = await c.query<{ sum: number }>('SELECT sum(n)::int AS sum FROM t');
        assert.equal(sum.rows[0].sum, 3);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    } finally {
      await pool.end();
    }
  });

  // pg has no "prefer" mode (it fails on our 'N'), so the SSLRequest path is
  // tested with psql, a real client that asks for SSL first and carries on
  // without it.
  await t.test('sslmode=prefer (psql)', async (t) => {
    try {
      const { stdout } = await promisify(execFile)(
        'psql',
        [`postgresql://interleave:interleave@${addr}/interleave?sslmode=prefer&connect_timeout=5`, '-tAc', 'SELECT current_database()'],
        { timeout: 10000 },
      );
      assert.equal(stdout.trim(), 'interleave');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        t.skip('psql not on PATH');
        return;
      }
      throw err;
    }
  });
});

// reachable reports whether something accepts TCP connections at addr within 1 s.
async function reachable(addr: string): Promise<boolean> {
  const [host, port] = addr.split(':');
  const s = net.connect({ host, port: Number(port) });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        s.once('connect', resolve);
        s.once('error', reject);
      }),
      'connect timeout',
      1000,
    );
    return true;
  } catch {
    return false;
  } finally {
    s.destroy();
  }
}

// assertNoLeaks closes the test's own sockets and the fake upstream, then
// checks that the number of open sockets, servers and timers is back where it
// was when the test started: the proxy left nothing running.
async function assertNoLeaks(
  before: number,
  conns: TestConn[],
  upstream: Awaited<ReturnType<typeof fakeUpstream>>,
): Promise<void> {
  for (const c of conns) {
    await c.close();
  }
  await upstream.close();
  // A closed server emits 'close' one event-loop turn before libuv releases
  // its handle, so give the count a moment to settle; a real leak never does.
  const deadline = Date.now() + 1000;
  while (openHandles() > before && Date.now() < deadline) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(openHandles(), before, `open handles after shutdown: ${process.getActiveResourcesInfo().join(', ')}`);
}



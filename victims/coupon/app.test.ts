import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DIRECT_DSN, PROXY_DSN, newHandler, newPool } from './app.ts';
import { poolViaProxy, post, readCoupon, resetDB, startServer, testPool } from './testutil.ts';
import { WireReader } from '../../src/pgwire/index.ts';
import { forward } from '../../src/proxy/index.ts';
import { onCleanup } from '../../src/testutil/cleanup.ts';

// fireConcurrently sends n redeem requests (user IDs 1..n) at the same moment.
// No starting gate is needed: the loop starts all n requests before any of
// them can run, because JavaScript runs one piece of code at a time.
async function fireConcurrently(baseURL: string, n: number): Promise<void> {
  await Promise.all(
    Array.from({ length: n }, (_, i) => post(baseURL, { body: JSON.stringify({ code: 'DIWALI50', user_id: i + 1 }) })),
  );
}

// RaceIsReal is the Phase 0 exit test. It fires many concurrent redeems at
// the app (talking straight to Postgres, no Interleave) and expects the
// single-use coupon to be redeemed more than once in at least one round.
// Whether the bad interleaving happens depends on timing, so it tries several
// rounds. This is the luck-based "blasting" that Interleave replaces.
test('RaceIsReal', async (t) => {
  const pool = await testPool(t);
  if (!pool) return;
  const url = await startServer(t, newHandler(pool, false));

  const rounds = 20;
  const concurrent = 50;
  for (let round = 1; round <= rounds; round++) {
    await resetDB(pool);
    await fireConcurrently(url, concurrent);
    const { uses, maxUses, redemptions } = await readCoupon(pool);
    if (uses > maxUses) {
      t.diagnostic(`round ${round}: single-use coupon redeemed ${uses} times (${redemptions} redemption rows)`);
      return;
    }
  }
  assert.fail(`no over-redeem in ${rounds} rounds of ${concurrent} concurrent requests`);
});

// FixedNeverOverRedeems blasts the --fixed variant exactly like RaceIsReal
// blasts the buggy one. With the row locked during the check, no round may
// over-redeem, and exactly one request must win.
test('FixedNeverOverRedeems', async (t) => {
  const pool = await testPool(t);
  if (!pool) return;
  const url = await startServer(t, newHandler(pool, true));

  for (let round = 1; round <= 20; round++) {
    await resetDB(pool);
    await fireConcurrently(url, 50);
    const { uses, maxUses, redemptions } = await readCoupon(pool);
    assert.ok(
      uses <= maxUses && redemptions === 1,
      `round ${round}: --fixed gave uses = ${uses} (max ${maxUses}), ${redemptions} redemption rows; want 1 and 1`,
    );
  }
});

// QueryLog collects what the proxy saw: "A SELECT" for tagged statements
// (tag and first SQL keyword), "ROLLBACK" for untagged ones.
class QueryLog {
  tagged: string[] = [];
  untagged: string[] = [];

  record(tag: string, sql: string): void {
    const i = sql.indexOf('*/');
    const text = tag !== '' && i >= 0 ? sql.slice(i + 2) : sql; // drop the tag comment
    const keyword = text.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    if (keyword === '') {
      return;
    }
    if (tag === '') {
      this.untagged.push(keyword);
    } else {
      this.tagged.push(`${tag} ${keyword}`);
    }
  }

  // take returns and clears what was recorded.
  take(): { tagged: string[]; untagged: string[] } {
    const r = { tagged: this.tagged, untagged: this.untagged };
    this.tagged = [];
    this.untagged = [];
    return r;
  }
}

// QueriesCarryRequestTag runs the app through a real Interleave proxy and
// checks which statements carry the tag from the X-Interleave-Req header.
test('QueriesCarryRequestTag', async (t) => {
  const direct = await testPool(t);
  if (!direct) return;
  await resetDB(direct);
  const seen = new QueryLog();
  const pool = await poolViaProxy(t, (_signal, tag, sql) => {
    seen.record(tag, sql);
    return undefined;
  });
  const url = await startServer(t, newHandler(pool, false));

  // A redeems the unused coupon: every statement, BEGIN to COMMIT, is tagged.
  assert.equal((await post(url, { tag: 'A' })).status, 200, 'request A');
  assert.deepEqual(seen.take(), { tagged: ['A BEGIN', 'A SELECT', 'A UPDATE', 'A INSERT', 'A COMMIT'], untagged: [] });

  // B finds it used up: BEGIN, SELECT and the app's own ROLLBACK are all
  // tagged (D-021), so nothing passes through untagged.
  assert.equal((await post(url, { tag: 'B' })).status, 409, 'request B');
  assert.deepEqual(seen.take(), { tagged: ['B BEGIN', 'B SELECT', 'B ROLLBACK'], untagged: [] });

  // No header (curl, the bench): nothing is tagged.
  assert.equal((await post(url)).status, 409, 'untagged request');
  assert.deepEqual(seen.take(), { tagged: [], untagged: ['BEGIN', 'SELECT', 'ROLLBACK'] });

  // The header goes into SQL, so anything but a plain tag is refused, before any SQL runs.
  for (const bad of ['A */ DROP TABLE coupons; --', 'A B', 'a'.repeat(65)]) {
    assert.equal((await post(url, { tag: bad })).status, 400, `header ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(seen.take(), { tagged: [], untagged: [] }, 'rejected requests ran SQL');
});

// StatementsUseSimpleProtocol proves Interleave can see every statement:
// node-postgres would switch to the extended protocol (Parse/Bind/Execute,
// which the MVP does not schedule) for any query with a values array. A relay
// between the app and Postgres records the type of every message the app sends.
test('StatementsUseSimpleProtocol', async (t) => {
  const direct = await testPool(t);
  if (!direct) return;
  await resetDB(direct);

  const types = new Set<string>();
  const open = new Set<net.Socket>();
  const relay = net.createServer((client) => {
    const server = net.connect({ host: '127.0.0.1', port: 5432 });
    for (const s of [client, server]) {
      open.add(s);
      s.once('close', () => open.delete(s));
    }
    const close = () => {
      client.destroy();
      server.destroy();
    };
    client.on('error', close);
    server.on('error', close);
    const fromClient = new WireReader(client);
    void (async () => {
      const startup = await fromClient.readStartup(); // sslmode=disable: no SSLRequest first
      if (startup === null) return close();
      server.write(startup.raw);
      await Promise.allSettled([
        forward(fromClient, server, { inspect: (m) => void types.add(m.type) }).finally(close),
        forward(new WireReader(server), client).finally(close),
      ]);
    })().catch(close);
  });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
  onCleanup(t, async () => {
    for (const s of open) s.destroy();
    await new Promise((r) => relay.close(r));
  });

  const pool = newPool(DIRECT_DSN.replace('127.0.0.1:5432', `127.0.0.1:${(relay.address() as net.AddressInfo).port}`));
  const url = await startServer(t, newHandler(pool, false));
  try {
    assert.equal((await post(url, { tag: 'A' })).status, 200); // BEGIN, SELECT, UPDATE, INSERT, COMMIT
    assert.equal((await post(url, { tag: 'B' })).status, 409); // BEGIN, SELECT, ROLLBACK
    assert.equal((await post(url, { body: '{"code":"NOPE","user_id":1}' })).status, 404);
  } finally {
    await pool.end(); // sends Terminate ('X')
  }
  // Q = simple Query, p = password (SCRAM) messages, X = Terminate. Never P/B/E/S/D.
  assert.ok(types.has('Q'), 'no Query message seen at all');
  assert.deepEqual([...types].filter((ty) => !['Q', 'p', 'X'].includes(ty)), [], `extended-protocol messages seen: ${[...types]}`);
});

// CodeIsEscaped: the coupon code is user input pasted into SQL. If it were not
// escaped, "DIWALI50' --" would turn the WHERE clause into code = 'DIWALI50'
// and redeem the coupon. Escaped, it is just an unknown code.
test('CodeIsEscaped', async (t) => {
  const pool = await testPool(t);
  if (!pool) return;
  await resetDB(pool);
  const url = await startServer(t, newHandler(pool, false));
  for (const code of ["DIWALI50' --", "x'; DROP TABLE coupons; --", "\\' OR 1=1 --"]) {
    const res = await post(url, { body: JSON.stringify({ code, user_id: 1 }) });
    assert.equal(res.status, 404, `code ${JSON.stringify(code)}: ${res.body}`);
  }
  assert.deepEqual(await readCoupon(pool), { uses: 0, maxUses: 1, redemptions: 0 }, 'the coupon must be untouched');
});

// RejectsBadBody: malformed requests get a 400 (or 404/405 for the wrong
// path or method), like the Go version's JSON decoder and router did.
test('RejectsBadBody', async (t) => {
  const pool = await testPool(t);
  if (!pool) return;
  await resetDB(pool);
  const url = await startServer(t, newHandler(pool, false));
  for (const body of ['not json', '[1]', '{"code":"DIWALI50","user_id":1.5}', '{"code":"DIWALI50","user_id":"1"}', '{"code":5}']) {
    assert.equal((await post(url, { body })).status, 400, `body ${body}`);
  }
  assert.equal((await post(url, { method: 'GET' })).status, 405);
  assert.equal((await post(url, { path: '/other' })).status, 404);
  assert.deepEqual(await readCoupon(pool), { uses: 0, maxUses: 1, redemptions: 0 }, 'a rejected request must not redeem');
});

// DefaultDSNGoesThroughProxy: by default the app talks to Interleave's proxy
// on 127.0.0.1:6433 (an IP, so Node cannot pick ::1 for "localhost").
test('DefaultDSNGoesThroughProxy', () => {
  const viaProxy = new URL(PROXY_DSN);
  assert.equal(viaProxy.hostname, '127.0.0.1');
  assert.equal(viaProxy.port, '6433');
  assert.equal(new URL(DIRECT_DSN).port, '5432');
});

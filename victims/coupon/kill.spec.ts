// The Phase 1 exit test. It needs the scheduler (src/sched), so it is kept
// out of `npm test` (the name ends in .spec.ts) until the scheduler exists:
//
//   npm run test:sched
//
// Rename it to kill.test.ts once the scheduler passes its own spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { newHandler } from './app.ts';
import { openPoolViaProxy, openServer, post, readCoupon, resetDB, testPool } from './testutil.ts';
import { Scheduler, type Step } from '../../src/sched/sched.ts';
import { withTimeout } from '../../src/proxy/testutil.ts';

// KillTest is the Phase 1 exit test (ROADMAP): a hard-coded schedule
// reproduces the coupon double-redeem 10/10 times, and the opposite order
// never does. Requests A and B are fired at the same moment through the real
// proxy; only the scheduler decides which statement runs when.
test('KillTest', async (t) => {
  const pool = await testPool(t); // skips the test if Postgres is down
  if (!pool) return;

  // A and B each do BEGIN, SELECT, UPDATE, INSERT, COMMIT. Both SELECTs run
  // before either UPDATE: both see uses = 0 and both redeem.
  const bad = ['A', 'A', 'B', 'B', 'A', 'A', 'A', 'B', 'B', 'B'];
  for (let i = 1; i <= 10; i++) {
    const { statuses, uses } = await redeemInOrder(pool, bad);
    assert.ok(
      uses === 2 && statuses.A === 200 && statuses.B === 200,
      `bad order, run ${i}: uses = ${uses}, statuses ${JSON.stringify(statuses)}; want the double-redeem (2, both 200)`,
    );
  }

  // The opposite: A runs to COMMIT before B starts. B's SELECT sees uses = 1,
  // B is refused, and its ROLLBACK (tagged, D-021) is B's third step.
  const serial = ['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B'];
  for (let i = 1; i <= 10; i++) {
    const { statuses, uses } = await redeemInOrder(pool, serial);
    assert.ok(
      uses === 1 && statuses.A === 200 && statuses.B === 409,
      `serial order, run ${i}: uses = ${uses}, statuses ${JSON.stringify(statuses)}; want 1, A 200, B 409`,
    );
  }
});

// redeemInOrder resets the database, fires redeem requests A and B together
// through a proxy driven by a scheduler with the given order, and returns each
// request's HTTP status and the coupon's final use count.
async function redeemInOrder(pool: pg.Pool, order: string[]): Promise<{ statuses: { A: number; B: number }; uses: number }> {
  await resetDB(pool);
  // Created before anything is opened: if it throws, there is nothing to clean up.
  const s = new Scheduler(order);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('run timed out after 10s')), 10000);
  let viaProxy: Awaited<ReturnType<typeof openPoolViaProxy>> | undefined;
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  try {
    const run = s.run(ctl.signal);
    run.catch(() => {}); // awaited below; this only stops an early rejection counting as unhandled

    viaProxy = await openPoolViaProxy((signal, tag, sql) => s.onQuery(signal, tag, sql));
    server = await openServer(newHandler(viaProxy.pool, false));
    const url = server.url;
    const [a, b] = await withTimeout(
      Promise.all(
        (['A', 'B'] as const).map((tag, i) => post(url, { tag, body: JSON.stringify({ code: 'DIWALI50', user_id: i + 1 }) })),
      ),
      `order ${order}: requests did not finish`,
      15000,
    );

    let trace: Step[];
    try {
      trace = await run;
    } catch (err) {
      assert.fail(`order ${order}: scheduler did not finish: ${String(err)}`);
    }
    assert.deepEqual(
      trace.map((st) => st.tag),
      order,
      'the scheduler did not run the given order',
    );
    const { uses } = await readCoupon(pool);
    return { statuses: { A: a.status, B: b.status }, uses };
  } finally {
    clearTimeout(timer);
    ctl.abort();
    await server?.close();
    await viaProxy?.close();
  }
}

// End to end through the extended query protocol (D-036): the coupon race,
// in an app that passes every value as a parameter ($1, $2) the way ORMs and
// most real apps do. Interleave must find the double redeem and clear the fix
// exactly as it does for the simple-protocol coupon app.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { endpoint, int, newPool, text, type Reply } from '../common/kit.ts';
import { startServer, testPool } from '../common/testutil.ts';
import { DEFAULT_TIMING, Engine, type RunResult } from '../../src/runner/index.ts';
import { loadScenario, type Scenario } from '../../src/scenario/index.ts';
import { onCleanup } from '../../src/testutil/cleanup.ts';

// paramHandler is the coupon redeem with parameters instead of inlined values.
// fixed locks the coupon row first (SELECT ... FOR UPDATE).
function paramHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return endpoint('/redeem', async (body, tc): Promise<Reply> => {
    const code = text(body, 'code');
    const userId = int(body, 'user_id');
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query(`${tc}BEGIN`);
      const { rows } = await client.query<{ uses: number; max_uses: number }>(
        `${tc}SELECT uses, max_uses FROM coupons WHERE code = $1${fixed ? ' FOR UPDATE' : ''}`,
        [code],
      );
      if (rows.length === 0) {
        return [404, 'unknown coupon'];
      }
      if (rows[0].uses >= rows[0].max_uses) {
        return [409, 'coupon already used up'];
      }
      await client.query(`${tc}UPDATE coupons SET uses = uses + 1 WHERE code = $1`, [code]);
      await client.query(`${tc}INSERT INTO redemptions (code, user_id) VALUES ($1, $2)`, [code, userId]);
      await client.query(`${tc}COMMIT`);
      committed = true;
      return [200, 'redeemed'];
    } finally {
      if (!committed) {
        await client.query(`${tc}ROLLBACK`).catch(() => {});
      }
      client.release();
    }
  });
}

const SCENARIO = fileURLToPath(new URL('./scenario.yaml', import.meta.url));

async function setup(t: TestContext, fixed: boolean): Promise<{ engine: Engine; scenario: Scenario } | undefined> {
  const direct = await testPool(t);
  if (!direct) return undefined;
  const engine = await Engine.start('127.0.0.1:0', '127.0.0.1:5432');
  onCleanup(t, () => engine.close());
  const pool = newPool(`postgres://interleave:interleave@${engine.proxyAddress}/interleave?sslmode=disable`);
  onCleanup(t, () => pool.end());
  const url = await startServer(t, paramHandler(pool, fixed));
  return { engine, scenario: { ...(await loadScenario(SCENARIO)), baseUrl: url } };
}

const options = { ...DEFAULT_TIMING, strategy: 'exhaustive' as const, seed: 1, maxRuns: 1000, all: false };

test('FindsTheRaceThroughParameterisedQueries', async (t) => {
  const s = await setup(t, false);
  if (!s) return;
  const summary = await s.engine.explore(s.scenario, options);
  assert.equal(summary.error, undefined, summary.error);
  assert.equal(summary.findings.length, 1, `no finding in ${summary.runs} runs`);
  const found = summary.findings[0];
  assert.deepEqual(found.findings, ['invariant', 'serial']);
  // Every statement was scheduled, including the parameterised ones.
  assert.ok(
    found.trace.steps.some((st) => st.sql.includes('$1')),
    'the parameterised statements must appear in the timeline',
  );
  const again: RunResult = await s.engine.replay(s.scenario, found.trace.decisions.map((d) => d.chosen), DEFAULT_TIMING);
  assert.deepEqual(again.findings, found.findings, 'the finding must replay');
});

test('ClearsTheFixThroughParameterisedQueries', async (t) => {
  const s = await setup(t, true);
  if (!s) return;
  const summary = await s.engine.explore(s.scenario, options);
  assert.equal(summary.error, undefined, summary.error);
  assert.deepEqual(summary.findings, []);
  assert.ok(summary.complete);
  // The same tree as the simple-protocol coupon: 36 orders.
  assert.equal(summary.runs, 36);
});

// End to end: `interleave run` on the coupon scenario, in-process. The engine
// must find the double-redeem by itself, the finding must replay identically,
// and the fixed app must come out clean with every order checked.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { newHandler, newPool } from './app.ts';
import { openServer, testPool } from './testutil.ts';
import { DEFAULT_TIMING, Engine, type RunResult } from '../../src/runner/index.ts';
import { loadScenario, type Scenario } from '../../src/scenario/index.ts';
import { formatTimeline } from '../../src/report/index.ts';
import { onCleanup } from '../../src/testutil/cleanup.ts';

const SCENARIO = fileURLToPath(new URL('./scenario.yaml', import.meta.url));

// setup starts the engine (proxy on a free port) and the coupon app pointed
// at it, and returns the scenario aimed at that app.
async function setup(t: TestContext, fixed: boolean): Promise<{ engine: Engine; scenario: Scenario } | undefined> {
  const direct = await testPool(t); // skips the test if Postgres is down
  if (!direct) return undefined;
  const engine = await Engine.start('127.0.0.1:0', '127.0.0.1:5432');
  onCleanup(t, () => engine.close());
  const pool = newPool(`postgres://interleave:interleave@${engine.proxyAddress}/interleave?sslmode=disable`);
  onCleanup(t, () => pool.end());
  const server = await openServer(newHandler(pool, fixed));
  onCleanup(t, () => server.close());
  const scenario = { ...(await loadScenario(SCENARIO)), baseUrl: server.url };
  return { engine, scenario };
}

const options = { ...DEFAULT_TIMING, strategy: 'exhaustive' as const, seed: 1, maxRuns: 1000, all: false };

test('ExhaustiveFindsTheDoubleRedeem', async (t) => {
  const s = await setup(t, false);
  if (!s) return;
  const summary = await s.engine.explore(s.scenario, options);
  assert.equal(summary.error, undefined, summary.error);
  assert.equal(summary.findings.length, 1, `want a finding; ran ${summary.runs} orders`);
  const found = summary.findings[0];
  assert.deepEqual(found.findings, ['invariant']);
  assert.deepEqual(
    found.responses.map((r) => r.status),
    [200, 200],
    'both requests redeemed',
  );
  t.diagnostic(`found after ${summary.runs} runs:\n${formatTimeline(found, s.scenario.requests)}`);

  // FR-22: the same choices reproduce the same violation.
  const choices = found.trace.decisions.map((d) => d.chosen);
  for (let i = 1; i <= 3; i++) {
    const again: RunResult = await s.engine.replay(s.scenario, choices, DEFAULT_TIMING);
    assert.equal(again.outcome, 'complete', again.error);
    assert.deepEqual(again.findings, ['invariant'], `replay ${i} did not reproduce the violation`);
    assert.deepEqual(again.trace.decisions, found.trace.decisions, `replay ${i} took a different path`);
  }
});

test('FixedIsCleanInEveryOrder', async (t) => {
  const s = await setup(t, true);
  if (!s) return;
  const summary = await s.engine.explore(s.scenario, options);
  assert.equal(summary.error, undefined, summary.error);
  assert.deepEqual(summary.findings, [], 'the fixed app must never break the invariants');
  assert.ok(summary.complete, `exploration must check every order (stopped after ${summary.runs} runs)`);
  t.diagnostic(`fixed: all ${summary.runs} orders checked in ${summary.seconds.toFixed(1)}s`);
});

test('RandomFindsItToo', async (t) => {
  const s = await setup(t, false);
  if (!s) return;
  const summary = await s.engine.explore(s.scenario, { ...options, strategy: 'random', seed: 1, maxRuns: 200 });
  assert.equal(summary.error, undefined, summary.error);
  assert.equal(summary.findings.length, 1, `random (seed 1) found nothing in ${summary.runs} runs`);
  t.diagnostic(`random seed 1: found after ${summary.runs} runs`);
});

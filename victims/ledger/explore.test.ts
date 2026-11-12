// Interleave on the ledger benchmark, in-process: findings are shrunk to the
// fewest switches that still lose the fee (D-033), and stay replayable.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { newHandler } from './app.ts';
import { newPool } from '../common/kit.ts';
import { startServer, testPool } from '../common/testutil.ts';
import { DEFAULT_TIMING, Engine, type RunResult } from '../../src/runner/index.ts';
import { loadScenario, type Scenario } from '../../src/scenario/index.ts';
import { switches } from '../../src/explore/index.ts';
import { formatTimeline } from '../../src/report/index.ts';
import { onCleanup } from '../../src/testutil/cleanup.ts';

const SCENARIO = fileURLToPath(new URL('./scenario.yaml', import.meta.url));

async function setup(t: TestContext): Promise<{ engine: Engine; scenario: Scenario } | undefined> {
  const direct = await testPool(t);
  if (!direct) return undefined;
  const engine = await Engine.start('127.0.0.1:0', '127.0.0.1:5432');
  onCleanup(t, () => engine.close());
  const pool = newPool(`postgres://interleave:interleave@${engine.proxyAddress}/interleave?sslmode=disable`);
  onCleanup(t, () => pool.end());
  const url = await startServer(t, newHandler(pool, false));
  return { engine, scenario: { ...(await loadScenario(SCENARIO)), baseUrl: url } };
}

const options = { ...DEFAULT_TIMING, strategy: 'random' as const, seed: 1, maxRuns: 500, all: false };

test('FindingsAreShrunk', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const summary = await s.engine.explore(s.scenario, options);
  assert.equal(summary.error, undefined, summary.error);
  assert.equal(summary.findings.length, 1, `random found nothing in ${summary.runs} runs`);
  const found = summary.findings[0];
  const shrunk = found.shrunk;
  assert.ok(shrunk !== undefined, 'the finding must say it was shrunk');
  const choices = found.trace.decisions.map((d) => d.chosen);
  assert.equal(shrunk.toSwitches, switches(choices));
  assert.ok(shrunk.toSwitches <= shrunk.fromSwitches);
  // The lost fee needs the deposit to read, the whole close, then the deposit
  // to write: 2 switches.
  assert.equal(shrunk.toSwitches, 2, formatTimeline(found, s.scenario.requests));
  assert.deepEqual(found.findings, ['invariant', 'serial']);
  t.diagnostic(`random seed 1: ${shrunk.fromSwitches} -> ${shrunk.toSwitches} switches in ${shrunk.attempts} extra runs`);

  const again: RunResult = await s.engine.replay(s.scenario, choices, DEFAULT_TIMING);
  assert.deepEqual(again.findings, found.findings, 'the shrunk schedule must replay');
});

test('NoShrinkKeepsTheOriginal', async (t) => {
  const s = await setup(t);
  if (!s) return;
  const summary = await s.engine.explore(s.scenario, { ...options, shrink: false });
  assert.equal(summary.findings.length, 1);
  assert.equal(summary.findings[0].shrunk, undefined);
});

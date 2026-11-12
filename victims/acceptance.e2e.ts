// Phase 2 acceptance: Interleave, in-process, against every victim app.
//   - exhaustive finds the race (an invariant violation) and the finding
//     replays identically three times;
//   - the fixed app is clean in every order, and every order was checked;
//   - random with seed 1, and PCT with seed 1 and depth 2, find the race too;
//   - with the invariants removed, the serial oracle alone finds it (Phase 3 exit, D-031).
// It also records how fast each was (written to .interleave/acceptance-results-<mode>.json
// for docs/RESULTS.md). INTERLEAVE_LOCK_DETECT=timeout runs it with the old
// lock-wait timeout instead of asking Postgres (D-030), for the comparison. Run with `npm run test:acceptance`: it is slow and
// shares tables with the victim tests, so it is not part of `npm test`.
import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { newPool } from './common/kit.ts';
import { startServer, testPool } from './common/testutil.ts';
import { newHandler as approval } from './approval/app.ts';
import { newHandler as coupon } from './coupon/app.ts';
import { newHandler as counter } from './counter/app.ts';
import { newHandler as inventory } from './inventory/app.ts';
import { newHandler as seat } from './seat/app.ts';
import { newHandler as transfer } from './transfer/app.ts';
import { newHandler as username } from './username/app.ts';
import { newHandler as wallet } from './wallet/app.ts';
import { DEFAULT_TIMING, Engine, type ExploreSummary, type LockDetect, type RunResult } from '../src/runner/index.ts';
import { loadScenario, type Scenario } from '../src/scenario/index.ts';
import { formatTimeline } from '../src/report/index.ts';
import { onCleanup } from '../src/testutil/cleanup.ts';

type NewHandler = (pool: pg.Pool, fixed: boolean) => http.RequestListener;

const VICTIMS: [name: string, newHandler: NewHandler][] = [
  ['coupon', coupon],
  ['inventory', inventory],
  ['seat', seat],
  ['wallet', wallet],
  ['username', username],
  ['transfer', transfer],
  ['approval', approval],
  ['counter', counter],
];

const LOCK_DETECT: LockDetect = process.env['INTERLEAVE_LOCK_DETECT'] === 'timeout' ? 'timeout' : 'pg';
const TIMING = { ...DEFAULT_TIMING, lockDetect: LOCK_DETECT };
const OPTIONS = { ...TIMING, strategy: 'exhaustive' as const, seed: 1, maxRuns: 1000, all: false };

// setup starts the engine (proxy on a free port) and the victim pointed at it,
// and returns the victim's scenario aimed at that app.
async function setup(t: TestContext, name: string, newHandler: NewHandler, fixed: boolean): Promise<{ engine: Engine; scenario: Scenario } | undefined> {
  const direct = await testPool(t); // skips the test if Postgres is down
  if (!direct) return undefined;
  const engine = await Engine.start('127.0.0.1:0', '127.0.0.1:5432');
  onCleanup(t, () => engine.close());
  const pool = newPool(`postgres://interleave:interleave@${engine.proxyAddress}/interleave?sslmode=disable`);
  onCleanup(t, () => pool.end());
  const url = await startServer(t, newHandler(pool, fixed));
  const scenario = await loadScenario(fileURLToPath(new URL(`./${name}/scenario.yaml`, import.meta.url)));
  return { engine, scenario: { ...scenario, baseUrl: url } };
}

// stats collects one entry per victim and check, written out at the end.
const stats: Record<string, Record<string, unknown>> = {};

function record(name: string, check: string, s: ExploreSummary): void {
  stats[name] ??= {};
  stats[name][check] = {
    runs: s.runs,
    complete: s.complete,
    seconds: round(s.seconds),
    resetSeconds: round(s.resetSeconds),
    runsPerSecond: round(s.runs / s.seconds),
    resetsPerSecond: s.resetSeconds > 0 ? round(s.runs / s.resetSeconds) : null,
    firstFindingAfterRuns: s.firstFindingAfterRuns ?? null,
    firstFindingAfterSeconds: s.firstFindingAfterSeconds === undefined ? null : round(s.firstFindingAfterSeconds),
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

after(async () => {
  if (Object.keys(stats).length === 0) {
    return;
  }
  const dir = fileURLToPath(new URL('../.interleave/', import.meta.url));
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}acceptance-results-${LOCK_DETECT}.json`, `${JSON.stringify({ when: new Date().toISOString(), timing: TIMING, victims: stats }, null, 2)}\n`);
});

for (const [name, newHandler] of VICTIMS) {
  test(`${name}: exhaustive finds the race and replay reproduces it`, async (t) => {
    const s = await setup(t, name, newHandler, false);
    if (!s) return;
    const summary = await s.engine.explore(s.scenario, OPTIONS);
    assert.equal(summary.error, undefined, summary.error);
    assert.equal(summary.findings.length, 1, `no finding in ${summary.runs} runs (complete: ${summary.complete})`);
    const found = summary.findings[0];
    // Both oracles agree: the first bad run breaks an invariant AND matches
    // no one-at-a-time order.
    assert.deepEqual(found.findings, ['invariant', 'serial']);
    record(name, 'exhaustive', summary);
    t.diagnostic(`found after ${summary.runs} runs:\n${formatTimeline(found, s.scenario.requests)}`);

    const choices = found.trace.decisions.map((d) => d.chosen);
    for (let i = 1; i <= 3; i++) {
      const again: RunResult = await s.engine.replay(s.scenario, choices, TIMING);
      assert.equal(again.outcome, 'complete', again.error);
      assert.deepEqual(again.findings, found.findings, `replay ${i} did not reproduce the violation`);
      assert.deepEqual(again.trace.decisions, found.trace.decisions, `replay ${i} took a different path`);
    }
  });

  test(`${name}: fixed is clean in every order`, async (t) => {
    const s = await setup(t, name, newHandler, true);
    if (!s) return;
    const summary = await s.engine.explore(s.scenario, OPTIONS);
    assert.equal(summary.error, undefined, summary.error);
    const bad = summary.findings[0];
    assert.equal(bad, undefined, bad && `the fixed app broke a rule:\n${formatTimeline(bad, s.scenario.requests)}`);
    assert.ok(summary.complete, `exploration must check every order (stopped after ${summary.runs} runs)`);
    record(name, 'fixed', summary);
    t.diagnostic(`all ${summary.runs} orders checked in ${summary.seconds.toFixed(1)}s`);
  });

  test(`${name}: random (seed 1) finds the race`, async (t) => {
    const s = await setup(t, name, newHandler, false);
    if (!s) return;
    const summary = await s.engine.explore(s.scenario, { ...OPTIONS, strategy: 'random', maxRuns: 200 });
    assert.equal(summary.error, undefined, summary.error);
    assert.equal(summary.findings.length, 1, `random found nothing in ${summary.runs} runs`);
    record(name, 'random', summary);
    t.diagnostic(`found after ${summary.runs} runs`);
  });

  test(`${name}: PCT (seed 1, depth 2) finds the race`, async (t) => {
    const s = await setup(t, name, newHandler, false);
    if (!s) return;
    const summary = await s.engine.explore(s.scenario, { ...OPTIONS, strategy: 'pct', depth: 2, maxRuns: 200 });
    assert.equal(summary.error, undefined, summary.error);
    assert.equal(summary.findings.length, 1, `PCT found nothing in ${summary.runs} runs`);
    record(name, 'pct', summary);
    t.diagnostic(`found after ${summary.runs} runs`);
  });

  // Phase 3 exit (D-031): with every invariant removed, the serial oracle
  // alone still finds the race.
  test(`${name}: serial oracle finds it without invariants`, async (t) => {
    const s = await setup(t, name, newHandler, false);
    if (!s) return;
    assert.ok(s.scenario.serial !== undefined, 'the scenario needs a serial section');
    const summary = await s.engine.explore({ ...s.scenario, invariants: [] }, OPTIONS);
    assert.equal(summary.error, undefined, summary.error);
    assert.equal(summary.findings.length, 1, `no finding in ${summary.runs} runs (complete: ${summary.complete})`);
    assert.deepEqual(summary.findings[0].findings, ['serial']);
    record(name, 'serialOnly', summary);
    t.diagnostic(`found after ${summary.runs} runs:\n${formatTimeline(summary.findings[0], s.scenario.requests)}`);
  });
}

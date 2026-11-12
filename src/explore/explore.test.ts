import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chooser, Decision } from '../sched/run.ts';
import { Exhaustive, NonDeterminismError, PctStrategy, RandomStrategy, replayChooser } from './index.ts';

// simulate plays one run of a tiny model app without a database: each
// request has a list of statements, every request with statements left is
// runnable at every decision, and the chooser picks which goes next.
// `branch` lets a request's remaining statements depend on what already ran
// (like an app that returns early when the coupon is used up).
function simulate(
  choose: Chooser,
  requests: Record<string, string[]>,
  branch?: (tag: string, ran: string[], left: string[]) => string[],
): { order: string; decisions: Decision[] } {
  const left = Object.fromEntries(Object.entries(requests).map(([tag, sqls]) => [tag, [...sqls]]));
  const ran: string[] = [];
  const decisions: Decision[] = [];
  for (;;) {
    const runnable = Object.keys(left)
      .filter((tag) => left[tag].length > 0)
      .sort();
    if (runnable.length === 0) {
      return { order: ran.join(' '), decisions };
    }
    const chosen = choose(runnable);
    decisions.push({ runnable, chosen });
    ran.push(`${chosen}${left[chosen].shift()}`);
    if (branch !== undefined) {
      for (const tag of Object.keys(left)) {
        left[tag] = branch(tag, ran, left[tag]);
      }
    }
  }
}

// exploreAll runs the exhaustive strategy to the end and returns every order it produced.
function exploreAll(requests: Record<string, string[]>, branch?: Parameters<typeof simulate>[2]): string[] {
  const ex = new Exhaustive();
  const orders: string[] = [];
  for (let chooser = ex.nextChooser(); chooser !== undefined; chooser = ex.nextChooser()) {
    const { order, decisions } = simulate(chooser, requests, branch);
    orders.push(order);
    ex.record(decisions);
    assert.ok(orders.length < 1000, 'exhaustive search did not end');
  }
  return orders;
}

test('ExhaustiveVisitsEveryOrderOnce', () => {
  // Two requests with two statements each: 4!/(2!*2!) = 6 interleavings.
  const orders = exploreAll({ A: ['1', '2'], B: ['1', '2'] });
  assert.equal(orders.length, 6);
  assert.equal(new Set(orders).size, 6, 'an order was explored twice');
  assert.equal(orders[0], 'A1 A2 B1 B2', 'run 1 always picks the first runnable request');
  // Three requests with one statement each: 3! = 6.
  assert.equal(new Set(exploreAll({ A: ['1'], B: ['1'], C: ['1'] })).size, 6);
});

test('ExhaustiveFollowsBranchingApps', () => {
  // B gives up after its first statement if A finished before B1 ran (like a
  // coupon found used up): orders are explored as they really happen, not
  // precomputed (D-006).
  const giveUp = (tag: string, ran: string[], left: string[]) =>
    tag === 'B' && ran.indexOf('A2') >= 0 && ran.indexOf('A2') < ran.indexOf('B1') ? [] : left;
  const orders = exploreAll({ A: ['1', '2'], B: ['1', '2'] }, giveUp);
  // When A finishes before B1 runs, B's second statement never happens.
  assert.ok(orders.includes('A1 A2 B1'), `missing the early-return order in ${orders.join(' | ')}`);
  assert.ok(!orders.includes('A1 A2 B1 B2'), 'an impossible order was produced');
  assert.equal(new Set(orders).size, orders.length, 'no duplicates');
});

test('ExhaustiveDetectsNonDeterminism', () => {
  const ex = new Exhaustive();
  const first = ex.nextChooser();
  assert.ok(first);
  const { decisions } = simulate(first, { A: ['1'], B: ['1'] });
  ex.record(decisions);
  const second = ex.nextChooser();
  assert.ok(second);
  // The replayed prefix expects a choice that is no longer runnable: the app
  // behaved differently from the previous run.
  assert.throws(() => second(['C']), NonDeterminismError);
});

test('RandomIsReproducibleBySeed', () => {
  const ordersFor = (seed: number) => {
    const r = new RandomStrategy(seed);
    return Array.from({ length: 20 }, () => simulate(r.nextChooser() as Chooser, { A: ['1', '2'], B: ['1', '2'], C: ['1'] }).order);
  };
  assert.deepEqual(ordersFor(7), ordersFor(7), 'same seed must give the same sequence of orders');
  assert.notDeepEqual(ordersFor(7), ordersFor(8), 'different seeds should give different orders');
  assert.ok(new Set(ordersFor(7)).size > 3, 'random should explore several different orders');
});

test('ReplayRepeatsTheRecordedChoices', () => {
  const order = simulate(replayChooser(['B', 'A', 'A', 'B']), { A: ['1', '2'], B: ['1', '2'] }).order;
  assert.equal(order, 'B1 A1 A2 B2');
  // A recorded choice that is not runnable (the app changed): error, not a guess.
  assert.throws(() => simulate(replayChooser(['C']), { A: ['1'] }), NonDeterminismError);
  // More decisions than recorded: the app made more steps than when recorded.
  assert.throws(() => simulate(replayChooser(['A']), { A: ['1', '2'] }), NonDeterminismError);
});

// PCT (D-032). The model of the ledger race: A reads (r) and later writes
// (w); B is a long job of 9 statements. The bug needs every statement of B
// between A's read and A's write: one preemption, at exactly the right place
// (a bug of depth 2), followed by a long uninterrupted run of B.
const LEDGER = { A: ['r', 'w'], B: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] };
const ledgerBug = (order: string) => /Ar B1 B2 B3 B4 B5 B6 B7 B8 B9 Aw/.test(order);

// hitRate runs a strategy many times on the model and returns how often the bug happened.
function hitRate(strategy: { nextChooser(): Chooser; record?(d: readonly Decision[]): void }, runs: number): number {
  let hits = 0;
  for (let i = 0; i < runs; i++) {
    const { order, decisions } = simulate(strategy.nextChooser(), LEDGER);
    strategy.record?.(decisions);
    if (ledgerBug(order)) {
      hits++;
    }
  }
  return hits / runs;
}

test('PctIsReproducibleBySeed', () => {
  const orders = (seed: number) => {
    const p = new PctStrategy(seed, 2);
    return Array.from({ length: 30 }, () => {
      const { order, decisions } = simulate(p.nextChooser(), LEDGER);
      p.record(decisions);
      return order;
    });
  };
  assert.deepEqual(orders(7), orders(7));
  assert.notDeepEqual(orders(7), orders(8));
});

test('PctDepth1NeverPreempts', () => {
  // Depth 1 = no change point: every run lets the highest-priority request
  // run to its end, then the next: only serial orders.
  const p = new PctStrategy(3, 1);
  for (let i = 0; i < 50; i++) {
    const { order, decisions } = simulate(p.nextChooser(), LEDGER);
    p.record(decisions);
    assert.ok(['Ar Aw B1 B2 B3 B4 B5 B6 B7 B8 B9', 'B1 B2 B3 B4 B5 B6 B7 B8 B9 Ar Aw'].includes(order), order);
  }
});

test('PctFindsADepth2BugAsOftenAsPromised', () => {
  // PCT's guarantee: a bug of depth d is hit with probability at least
  // 1/(n * k^(d-1)) per run; here n = 2 requests, k = 11 steps: 1/22 (4.5%).
  // Here the bound is exact (A must get the higher priority, 1/2, and the
  // change point must fall on A's write, 1/11), and a sample of runs scatters
  // around it, so allow 20% below it. The seeds are fixed: not flaky.
  const pct = hitRate(new PctStrategy(1, 2), 4000);
  const random = hitRate(new RandomStrategy(1), 4000);
  assert.ok(pct >= 0.8 / 22, `PCT hit the bug in ${(pct * 100).toFixed(1)}% of runs, far below the 1/22 bound`);
  assert.ok(pct > 5 * random, `PCT ${(pct * 100).toFixed(1)}% vs random ${(random * 100).toFixed(2)}%: want PCT far ahead`);
});

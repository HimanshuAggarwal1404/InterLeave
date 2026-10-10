// These tests are the spec for sched v1 (Phase 1): park tagged steps and
// release them in a hard-coded order. They were written before the code, so
// they are kept out of `npm test` (the file name ends in .spec.ts, not
// .test.ts) until the scheduler passes them:
//
//   npm run test:sched
//
// Once they pass, rename this file to sched.test.ts so `npm test` runs it.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RunAbortedError, Scheduler, type DoneFn, type Step } from './sched.ts';

const TIMEOUT_MS = 5000;

// testSignal is the signal for one test: it aborts after 5 s (so a stuck
// scheduler fails the test instead of hanging it) and when the test ends (so
// the scheduler can clean up).
function testSignal(t: TestContext): AbortSignal {
  const ctl = new AbortController();
  t.after(() => ctl.abort());
  return AbortSignal.any([ctl.signal, AbortSignal.timeout(TIMEOUT_MS)]);
}

// fakeRequest plays one request through the scheduler, the way the proxy
// would: for each statement it calls onQuery (waiting while the step is
// parked), records that the statement now runs, then reports it finished.
async function fakeRequest(signal: AbortSignal, s: Scheduler, tag: string, sqls: string[], ran: string[]): Promise<void> {
  for (const sql of sqls) {
    const done = await s.onQuery(signal, tag, sql);
    ran.push(`${tag} ${sql}`);
    done?.('T');
  }
}

// startRun starts s.run. A run that is never awaited may still reject later;
// the empty catch stops that from counting as an unhandled rejection. The
// returned Promise is the original, so awaiting it still sees the rejection.
function startRun(s: Scheduler, signal: AbortSignal): Promise<Step[]> {
  const run = s.run(signal);
  run.catch(() => {});
  return run;
}

// receive waits up to 5 s for p to resolve; otherwise the test fails with failMsg.
async function receive<T>(p: Promise<T>, failMsg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(failMsg)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// notWithin checks that p does not settle for a short while. It can only
// catch a wrong release that happens quickly, which is how a scheduler bug
// shows up here; it never makes a correct scheduler fail.
async function notWithin(p: Promise<unknown>, failMsg: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const early = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 150);
    }),
  ]);
  clearTimeout(timer);
  if (early) {
    assert.fail(failMsg);
  }
}

// settled resolves when p settles either way: for steps that may give up by
// resolving or by rejecting.
function settled(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => undefined,
    () => undefined,
  );
}

test('ReleasesStepsInTheGivenOrder', async (t) => {
  const reqs: Record<string, string[]> = {
    A: ['a1', 'a2', 'a3'],
    B: ['b1', 'b2'],
  };
  const cases: Array<{ name: string; order: string[]; want: string[] }> = [
    { name: 'A then B', order: ['A', 'A', 'A', 'B', 'B'], want: ['A a1', 'A a2', 'A a3', 'B b1', 'B b2'] },
    { name: 'B then A', order: ['B', 'B', 'A', 'A', 'A'], want: ['B b1', 'B b2', 'A a1', 'A a2', 'A a3'] },
    { name: 'interleaved', order: ['A', 'B', 'B', 'A', 'A'], want: ['A a1', 'B b1', 'B b2', 'A a2', 'A a3'] },
  ];
  for (const tt of cases) {
    await t.test(tt.name, async (t) => {
      const signal = testSignal(t);
      const s = new Scheduler(tt.order);
      const run = startRun(s, signal);

      const ran: string[] = [];
      await receive(
        Promise.all(Object.entries(reqs).map(([tag, sqls]) => fakeRequest(signal, s, tag, sqls, ran))),
        'the requests did not finish',
      );
      assert.deepEqual(ran, tt.want, 'statements ran in the wrong order');

      const trace = await receive(run, 'run did not resolve after the last step finished');
      for (const st of trace) {
        assert.equal(st.status, 'T', `step ${st.sql} has status ${st.status}, want the one done reported ('T')`);
      }
      assert.deepEqual(
        trace.map((st) => `${st.tag} ${st.sql}`),
        tt.want,
        "run's trace is not the order the steps ran in",
      );
    });
  }
});

// The next step is released only after the previous one has finished (its
// done was called), so two steps never run at the same time.
test('NextStepWaitsForDone', async (t) => {
  const signal = testSignal(t);
  const s = new Scheduler(['A', 'B']);
  startRun(s, signal);

  const doneA = await receive(s.onQuery(signal, 'A', 'a1'), "A's step was never released");
  assert.ok(doneA, "A's step is scheduled, so it needs a done");

  const bReleased = s.onQuery(signal, 'B', 'b1');
  await notWithin(bReleased, "B was released while A's step was still running");

  doneA('T');
  await receive(bReleased, "B was not released after A's step finished");
});

// A step of a request that is not next in the order stays parked, even if it
// arrives first.
test('WaitsForTheRequestWhoseTurnItIs', async (t) => {
  const signal = testSignal(t);
  const s = new Scheduler(['B', 'A']);
  startRun(s, signal);

  const aReleased = s.onQuery(signal, 'A', 'a1');
  await notWithin(aReleased, 'A was released although the order starts with B');

  const doneB: DoneFn | undefined = await receive(s.onQuery(signal, 'B', 'b1'), 'B was never released');
  assert.ok(doneB);
  await notWithin(aReleased, "A was released while B's step was still running");
  doneB('I');
  await receive(aReleased, 'A was not released after B finished');
});

// Untagged statements (health checks, apps that cannot tag; D-016) and tags
// the order never mentions are not scheduled: onQuery resolves at once, with
// no done, even before run starts.
test('UnscheduledQueriesPassThrough', async (t) => {
  const signal = testSignal(t);
  const s = new Scheduler(['A']);
  for (const tag of ['', 'C']) {
    const done = await receive(s.onQuery(signal, tag, 'ROLLBACK'), `onQuery blocked for tag ${JSON.stringify(tag)}`);
    assert.equal(done, undefined, `tag ${JSON.stringify(tag)}: onQuery returned a done, want undefined (not scheduled)`);
  }
});

// Once the order is used up, run resolves and later steps run freely.
test('AfterTheOrderEverythingPassesThrough', async (t) => {
  const signal = testSignal(t);
  const s = new Scheduler(['A']);
  const run = startRun(s, signal);

  await receive(fakeRequest(signal, s, 'A', ['a1'], []), "A's only step was never released");
  await receive(run, 'run did not resolve after the order was used up');

  await receive(s.onQuery(signal, 'A', 'a2'), 'a step after the order was used up stayed parked');
});

// A parked step whose connection goes away (the proxy aborts onQuery's
// signal) must give up instead of waiting forever.
test('CancelledStepGivesUp', async () => {
  const s = new Scheduler(['A']); // run never starts, so nothing is ever released
  const ctl = new AbortController();
  const got = s.onQuery(ctl.signal, 'A', 'a1');
  await notWithin(got, 'onQuery settled although nothing released it');
  ctl.abort();
  await receive(settled(got), 'onQuery did not settle after its signal aborted');
});

// Aborting run (run timeout, Ctrl+C) rejects with RunAbortedError carrying
// the trace so far, and un-parks every waiting step so no proxy connection is stuck.
test('CancelledRunReleasesParkedSteps', async (t) => {
  const runCtl = new AbortController();
  const s = new Scheduler(['A', 'B']); // A never comes, so B waits forever
  const run = startRun(s, runCtl.signal);

  const signal = testSignal(t);
  const bGot = s.onQuery(signal, 'B', 'b1');
  await notWithin(bGot, 'B was released before A');

  runCtl.abort();
  const err = await receive(
    run.then(
      () => assert.fail('run resolved, want it to reject after its signal aborted'),
      (e: unknown) => e,
    ),
    'run did not settle after its signal aborted',
  );
  assert.ok(err instanceof RunAbortedError, `run rejected with ${String(err)}, want a RunAbortedError`);
  assert.equal((err.cause as Error | undefined)?.name, 'AbortError', 'cause should be the signal reason');
  assert.deepEqual(err.trace, [], 'nothing ran, so the trace must be empty');
  await receive(settled(bGot), "B's onQuery stayed parked after run ended");
});

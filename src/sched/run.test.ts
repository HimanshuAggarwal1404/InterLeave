// Spec for the Phase 2 scheduler (RunScheduler): request states, decision
// points, quiet period, lock-wait timeout, and choices made by a chooser.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RunScheduler, type Chooser, type RunDoneFn, type RunTrace } from './run.ts';

const TIMEOUT_MS = 5000;

// testSignal aborts when the test ends, and after twice receive's limit (so a
// stuck scheduler cannot hang the run, but receive's check always fires first).
function testSignal(t: TestContext): AbortSignal {
  const ctl = new AbortController();
  t.after(() => ctl.abort());
  return AbortSignal.any([ctl.signal, AbortSignal.timeout(2 * TIMEOUT_MS)]);
}

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

// notWithin checks that p does not settle within ms.
async function notWithin(p: Promise<unknown>, failMsg: string, ms = 150): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const early = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  if (early) {
    assert.fail(failMsg);
  }
}

// first is a chooser that always picks the first runnable request.
const first: Chooser = (runnable) => runnable[0];

// scheduler builds a RunScheduler with test-friendly defaults: the quiet
// period is long, so tests decide explicitly when requests stop "running".
function scheduler(requests: string[], options: Partial<ConstructorParameters<typeof RunScheduler>[0]> = {}): RunScheduler {
  return new RunScheduler({ requests, choose: first, quietMs: 60_000, lockWaitMs: 60_000, ...options });
}

// fakeRequest plays one request through the scheduler the way the proxy and
// the harness would: each statement goes through onQuery (waiting while
// parked), is recorded as running, then reports done; at the end the request
// finishes (its HTTP response arrived).
async function fakeRequest(signal: AbortSignal, s: RunScheduler, tag: string, sqls: string[], ran: string[]): Promise<void> {
  for (const sql of sqls) {
    const done = await s.onQuery(signal, tag, sql);
    ran.push(`${tag} ${sql}`);
    done?.('T', { command: sql.toUpperCase() });
  }
  s.requestFinished(tag);
}

test('DecidesOnlyWhenNoRequestIsRunning', async (t) => {
  const signal = testSignal(t);
  const calls: string[][] = [];
  const s = scheduler(['A', 'B'], { choose: (r) => (calls.push([...r]), r[0]) });
  const run = s.run(signal);

  // A parks while B is still "running" (in app code, nothing sent yet):
  // no decision may be made, because B might be about to send a statement.
  const a = s.onQuery(signal, 'A', 'a1');
  await notWithin(a, 'a decision was made while request B was still running');
  assert.deepEqual(calls, []);

  // B parks too: now every request is parked, so this is a decision point.
  const b = s.onQuery(signal, 'B', 'b1');
  const doneA = await receive(a, 'A was not released at the decision point');
  assert.deepEqual(calls, [['A', 'B']], 'the chooser must see both parked requests, in request order');
  doneA?.('I', {});
  s.requestFinished('A');
  (await receive(b, 'B was not released after A finished'))?.('I', {});
  s.requestFinished('B');
  const trace = await receive(run, 'run did not finish after every request finished');
  assert.equal(trace.outcome, 'complete');
});

test('ChooserDecidesTheOrder', async (t) => {
  const signal = testSignal(t);
  // Always prefer B when it is runnable.
  const s = scheduler(['A', 'B'], { choose: (r) => (r.includes('B') ? 'B' : r[0]) });
  const run = s.run(signal);
  const ran: string[] = [];
  await receive(
    Promise.all([fakeRequest(signal, s, 'A', ['a1', 'a2'], ran), fakeRequest(signal, s, 'B', ['b1', 'b2'], ran)]),
    'the requests did not finish',
  );
  assert.deepEqual(ran, ['B b1', 'B b2', 'A a1', 'A a2']);
  const trace = await receive(run, 'run did not finish');
  assert.equal(trace.outcome, 'complete');
  assert.deepEqual(
    trace.steps.map((st) => `${st.tag} ${st.sql} ${st.status} ${st.result?.command}`),
    ['B b1 T B1', 'B b2 T B2', 'A a1 T A1', 'A a2 T A2'],
    'the trace lists released steps in order, with status and result',
  );
  assert.deepEqual(
    trace.decisions.map((d) => `${d.runnable.join('')}>${d.chosen}`),
    ['AB>B', 'AB>B', 'A>A', 'A>A'],
    'every release is a recorded decision, with what was runnable',
  );
});

test('OneStepAtATime', async (t) => {
  const signal = testSignal(t);
  const s = scheduler(['A', 'B', 'C']);
  s.run(signal);
  const c = s.onQuery(signal, 'C', 'c1');
  const a = s.onQuery(signal, 'A', 'a1');
  const b = s.onQuery(signal, 'B', 'b1');
  const doneA = await receive(a, 'A was never released');
  await notWithin(b, 'B was released while A was still executing');
  // Another event while A executes (request C finishes, so nobody is running
  // and B is parked) must still not release B: one statement executes at a time.
  s.requestFinished('C');
  assert.equal(await receive(c, 'C did not settle after its request finished'), undefined);
  await notWithin(b, 'B was released by an unrelated event while A was still executing');
  doneA?.('T', {});
  // A is running again (in app code), so B waits for the quiet period or for
  // A to park/finish. A finishing makes it a decision point.
  s.requestFinished('A');
  await receive(b, 'B was not released after A finished');
});

test('QuietPeriodDecidesWithoutWaitingForever', async (t) => {
  const signal = testSignal(t);
  const calls: string[][] = [];
  const s = scheduler(['A', 'B'], { quietMs: 50, choose: (r) => (calls.push([...r]), r[0]) });
  s.run(signal);
  const a = s.onQuery(signal, 'A', 'a1');
  const b = s.onQuery(signal, 'B', 'b1');
  (await receive(a, 'A was never released'))?.('T', {});
  // A is back in app code and never sends anything more. After the quiet
  // period B is released anyway.
  const started = Date.now();
  await receive(b, 'B was never released although A stayed quiet');
  assert.ok(Date.now() - started >= 40, 'released before the quiet period passed');
  assert.deepEqual(calls, [['A', 'B'], ['B']]);
});

test('WaitsLongerForAFirstStatement', async (t) => {
  const signal = testSignal(t);
  const calls: string[][] = [];
  // The quiet period is short, but B has not sent its first statement yet (its
  // app may still be opening a database connection): a decision waits for the
  // start grace, so the first decision does not depend on connection timing.
  const s = scheduler(['A', 'B'], { quietMs: 20, startGraceMs: 60_000, choose: (r) => (calls.push([...r]), r[0]) });
  s.run(signal);
  const a = s.onQuery(signal, 'A', 'a1');
  await notWithin(a, 'A was released while B had not sent its first statement yet');
  s.onQuery(signal, 'B', 'b1');
  await receive(a, 'A was not released once B parked');
  assert.deepEqual(calls, [['A', 'B']]);
});

test('StartGraceEnds', async (t) => {
  const signal = testSignal(t);
  const s = scheduler(['A', 'B'], { quietMs: 20, startGraceMs: 100 });
  // B never sends anything: after the start grace (counted from the start of
  // the run) A is released anyway.
  const started = Date.now();
  s.run(signal);
  await receive(s.onQuery(signal, 'A', 'a1'), 'A was never released although the start grace passed');
  assert.ok(Date.now() - started >= 90, 'released before the start grace passed');
});

test('LockWaitMarksBlockedAndContinues', async (t) => {
  const signal = testSignal(t);
  const s = scheduler(['A', 'B'], { lockWaitMs: 50 });
  const run = s.run(signal);
  const a = s.onQuery(signal, 'A', 'a1');
  const b = s.onQuery(signal, 'B', 'b1');
  const doneA = await receive(a, 'A was never released');
  // A's statement gets no reply (it waits on a row lock). After the lock-wait
  // timeout A counts as blocked, and B is released.
  const doneB = await receive(b, 'B was not released after A was blocked for the lock-wait timeout');
  doneB?.('T', {});
  s.requestFinished('B');
  doneA?.('T', { command: 'UPDATE 1' }); // A's lock is free at last
  s.requestFinished('A');
  const trace = await receive(run, 'run did not finish');
  assert.equal(trace.outcome, 'complete');
  assert.deepEqual(
    trace.steps.map((st) => `${st.tag} blocked=${st.blocked} ${st.status}`),
    ['A blocked=true T', 'B blocked=false T'],
  );
});

// Lock-wait detection by asking Postgres (D-030). The probe stands in for
// `SELECT pg_blocking_pids(pid)`: it gets the PID of the statement's
// connection and answers with the PIDs blocking it ([] = not blocked).
const PIDS: Record<string, number> = { A: 101, B: 102 };

test('ProbeMarksBlockedAtOnce', async (t) => {
  const signal = testSignal(t);
  // A waits for a lock that B holds (B's PID blocks A's). The lock-wait
  // timeout is huge, so only the probe can let B go.
  const s = scheduler(['A', 'B'], { lockPollMs: 5, probeBlocked: async (pid) => (pid === PIDS.A ? [PIDS.B] : []) });
  const run = s.run(signal);
  const a = s.onQuery(signal, 'A', 'a1', PIDS.A);
  const b = s.onQuery(signal, 'B', 'b1', PIDS.B);
  const doneA = await receive(a, 'A was never released');
  const doneB = await receive(b, 'B was not released although the probe said A is blocked');
  doneB?.('T', {});
  s.requestFinished('B');
  doneA?.('T', {});
  s.requestFinished('A');
  const trace = await receive(run, 'run did not finish');
  assert.deepEqual(
    trace.steps.map((st) => `${st.tag} blocked=${st.blocked} by=${(st.blockedBy ?? []).join(',')}`),
    ['A blocked=true by=B', 'B blocked=false by='],
  );
});

test('ProbeSaysNotBlockedKeepsWaiting', async (t) => {
  const signal = testSignal(t);
  // A is slow but not blocked: the probe keeps saying so, so B must wait for
  // A even after the (short) lock-wait timeout: the probe replaces the guess.
  let probes = 0;
  const s = scheduler(['A', 'B'], { lockWaitMs: 20, lockPollMs: 5, probeBlocked: async (pid) => (pid === PIDS.A && probes++, []) });
  s.run(signal);
  const a = s.onQuery(signal, 'A', 'a1', PIDS.A);
  const b = s.onQuery(signal, 'B', 'b1', PIDS.B);
  const doneA = await receive(a, 'A was never released');
  await notWithin(b, 'B was released although the probe said A is not blocked');
  assert.ok(probes >= 2, `the probe must be polled while A executes (asked ${probes} times)`);
  doneA?.('T', {});
  // Polling stops once A's reply is in.
  const after = probes;
  s.requestFinished('A');
  await receive(b, 'B was not released after A finished');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(probes <= after + 1, `A's PID was still probed after its statement finished (${probes - after} more)`);
});

test('ProbeFallsBackToTimeout', async (t) => {
  const signal = testSignal(t);
  for (const [name, pid, probe] of [
    ['the statement has no PID', undefined, async () => [PIDS.B]],
    ['the probe fails', PIDS.A, async () => Promise.reject(new Error('admin connection lost'))],
  ] as const) {
    await t.test(name, async () => {
      const s = scheduler(['A', 'B'], { lockWaitMs: 50, lockPollMs: 5, probeBlocked: probe });
      const run = s.run(signal);
      const a = s.onQuery(signal, 'A', 'a1', pid);
      const b = s.onQuery(signal, 'B', 'b1', PIDS.B);
      const doneA = await receive(a, 'A was never released');
      const doneB = await receive(b, 'B was not released after the lock-wait timeout');
      doneB?.('T', {});
      s.requestFinished('B');
      doneA?.('T', {});
      s.requestFinished('A');
      const trace = await receive(run, 'run did not finish');
      assert.deepEqual(
        trace.steps.map((st) => `${st.tag} blocked=${st.blocked}`),
        ['A blocked=true', 'B blocked=false'],
      );
    });
  }
});

test('UnscheduledQueriesPassThrough', async (t) => {
  const signal = testSignal(t);
  const s = scheduler(['A']);
  s.run(signal);
  for (const tag of ['', 'C']) {
    assert.equal(await receive(s.onQuery(signal, tag, 'SELECT 1'), `tag ${JSON.stringify(tag)} was parked`), undefined);
  }
});

test('FinishesWhenEveryRequestFinished', async (t) => {
  const signal = testSignal(t);
  const s = scheduler(['A', 'B']);
  const run = s.run(signal);
  // B finishes without any SQL (e.g. it got a 400): A alone decides.
  s.requestFinished('B');
  const ran: string[] = [];
  await receive(fakeRequest(signal, s, 'A', ['a1'], ran), 'A did not finish');
  const trace: RunTrace = await receive(run, 'run did not finish');
  assert.equal(trace.outcome, 'complete');
  assert.deepEqual(ran, ['A a1']);
});

test('AbortReleasesEverything', async (t) => {
  const signal = testSignal(t);
  const runCtl = new AbortController();
  const s = scheduler(['A', 'B']);
  const run = s.run(runCtl.signal);
  const a = s.onQuery(signal, 'A', 'a1'); // parked: B is still running, so no decision
  await notWithin(a, 'A was released although B was running');
  runCtl.abort(new Error('run timeout'));
  assert.equal(await receive(a, 'A stayed parked after the run was aborted'), undefined, 'let go unscheduled');
  const trace = await receive(run, 'run did not settle after abort');
  assert.equal(trace.outcome, 'aborted');
  assert.match(String(trace.reason), /run timeout/);
  // After the end nothing parks any more.
  assert.equal(await receive(s.onQuery(signal, 'B', 'b1'), 'B parked after the run ended'), undefined);
});

test('ChooserErrorEndsTheRun', async (t) => {
  const signal = testSignal(t);
  for (const [name, choose] of [
    ['throws', (() => {
      throw new Error('replay diverged');
    }) as Chooser],
    ['picks a request that is not runnable', (() => 'C') as Chooser],
  ] as const) {
    await t.test(name, async () => {
      const s = scheduler(['A'], { choose });
      const run = s.run(signal);
      const a = s.onQuery(signal, 'A', 'a1');
      assert.equal(await receive(a, 'A stayed parked after the chooser failed'), undefined);
      const trace = await receive(run, 'run did not settle');
      assert.equal(trace.outcome, 'error');
    });
  }
});

test('StepSignalAbortReleasesTheStep', async (t) => {
  const signal = testSignal(t);
  const s = scheduler(['A', 'B']);
  s.run(signal);
  const conn = new AbortController();
  const a = s.onQuery(conn.signal, 'A', 'a1'); // B still running: A waits
  await notWithin(a, 'A was released although B was running');
  conn.abort(); // A's connection died
  assert.equal(await receive(a, 'A did not settle after its connection died'), undefined);
});

test('BeforeReleaseIsAwaited', async (t) => {
  const signal = testSignal(t);
  let allow: (() => void) | undefined;
  const asked: string[] = [];
  const s = scheduler(['A'], {
    beforeRelease: (step) => {
      asked.push(`${step.tag} ${step.sql}`);
      return new Promise<void>((resolve) => (allow = resolve));
    },
  });
  s.run(signal);
  const a = s.onQuery(signal, 'A', 'a1');
  await notWithin(a, 'A was released before beforeRelease allowed it');
  assert.deepEqual(asked, ['A a1']);
  allow?.();
  const done: RunDoneFn | undefined = await receive(a, 'A was not released after beforeRelease resolved');
  assert.ok(done);
});

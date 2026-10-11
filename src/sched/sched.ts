// Package sched, v1 (Phase 1): park tagged steps and release them, one at a
// time, in a hard-coded order. The spec is src/sched/sched.test.ts and the
// Phase 1 exit test is victims/coupon/kill.test.ts.
//
// How it works, in one paragraph: every scheduled step's onQuery returns a
// Promise that stays pending (the step is parked) and keeps that Promise's
// resolve function. One private method, #releaseNext, is the only place that
// decides what runs: it is called whenever something changes (a step arrives,
// a step finishes, run starts) and releases the parked step whose turn it is,
// if that step has arrived and nothing else is running. Releasing = calling the
// step's resolve with a done function; calling done records the step and asks
// #releaseNext again.
//
// sched must not import networking code: the spec drives it with fake steps.
import type { ReadyStatus } from '../pgwire/index.ts';

// DoneFn reports that a released step has finished, with the status of its
// ReadyForQuery. Same shape as the proxy's DoneFn, so the proxy can call it.
export type DoneFn = (status: ReadyStatus) => void;

// Step is one statement that ran, in the order it ran.
export type Step = { tag: string; sql: string; status: ReadyStatus };

// RunAbortedError is how run() fails when its signal aborts (run timeout,
// Ctrl+C): trace holds the steps that ran before that, and cause is the
// signal's reason.
export class RunAbortedError extends Error {
  override name = 'RunAbortedError';
  readonly trace: Step[];

  constructor(trace: Step[], cause: unknown) {
    super('sched: run aborted', { cause });
    this.trace = trace;
  }
}

// Parked is a step waiting for its turn.
type Parked = {
  tag: string;
  sql: string;
  // release settles the step's onQuery Promise: with a DoneFn when it may
  // run, with undefined when it is let go unscheduled (run ended or aborted).
  release: (done: DoneFn | undefined) => void;
  // unlisten removes the step's abort listener once it no longer waits.
  unlisten: () => void;
};

export class Scheduler {
  readonly #order: readonly string[];
  // How many entries of the order each tag still has for steps that have not
  // arrived yet. A step that arrives when its tag has none left is not
  // scheduled (an untagged query, a tag the order never names, or a request
  // sending more steps than the order lists for it).
  #turnsLeft = new Map<string, number>();
  #next = 0; // index in #order of the next step to release
  #parked: Parked[] = []; // steps waiting, oldest first
  #running = false; // a released step has not called done yet
  #trace: Step[] = [];
  #started = false; // run() has been called
  #ended = false; // the order is used up or the run was aborted: nothing parks any more
  #finish: ((trace: Step[]) => void) | undefined; // resolves run()'s Promise
  #stopListening: (() => void) | undefined; // removes run()'s abort listener

  // order lists request tags in release order. The n-th "A" in it means
  // request A's n-th tagged statement; the scheduler does not know A's
  // statements in advance, it counts them as they arrive.
  // Example (the coupon double-redeem): A, A, B, B, A, A, A, B, B, B.
  constructor(order: readonly string[]) {
    this.#order = [...order]; // our own copy: the caller may change theirs later
    for (const tag of order) {
      this.#turnsLeft.set(tag, (this.#turnsLeft.get(tag) ?? 0) + 1);
    }
  }

  // onQuery has the shape of the proxy's hook (D-017). Wire it up with an
  // arrow function, (signal, tag, sql) => s.onQuery(signal, tag, sql),
  // because passing s.onQuery on its own would lose `this`.
  //
  // It resolves at once with undefined for a step that is not scheduled.
  // Otherwise it parks the step: the Promise stays pending until the step's
  // turn has come and the previous step has finished, then resolves with the
  // DoneFn that reports this step's completion. If `signal` aborts first (the
  // step's connection went away), it resolves with undefined.
  onQuery(signal: AbortSignal, tag: string, sql: string): Promise<DoneFn | undefined> {
    const turns = this.#turnsLeft.get(tag) ?? 0;
    if (tag === '' || turns === 0 || this.#ended || signal.aborted) {
      return Promise.resolve(undefined);
    }
    this.#turnsLeft.set(tag, turns - 1);

    // The Promise's resolve function is handed to the scheduler (inside the
    // Parked entry): from now on only the scheduler decides when it settles.
    return new Promise<DoneFn | undefined>((resolve) => {
      const step: Parked = { tag, sql, release: resolve, unlisten: () => {} };
      const onAbort = () => {
        this.#parked = this.#parked.filter((p) => p !== step);
        resolve(undefined);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      step.unlisten = () => signal.removeEventListener('abort', onAbort);
      this.#parked.push(step);
      this.#releaseNext();
    });
  }

  // run drives the order: release exactly one step at a time, the next only
  // after the previous step's DoneFn was called. It resolves with the trace
  // once every entry of the order has run. If `signal` aborts first, it
  // rejects with RunAbortedError(trace so far, signal.reason) and lets every
  // parked step go, so no proxy connection stays stuck.
  run(signal: AbortSignal): Promise<Step[]> {
    if (this.#started) {
      return Promise.reject(new Error('sched: run() can only be called once'));
    }
    this.#started = true;
    return new Promise<Step[]>((resolve, reject) => {
      const onAbort = () => {
        const trace = [...this.#trace];
        this.#end();
        reject(new RunAbortedError(trace, signal.reason));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.#stopListening = () => signal.removeEventListener('abort', onAbort);
      this.#finish = resolve;
      // Steps may have parked before run started; one may be releasable now.
      this.#releaseNext();
    });
  }

  // #releaseNext is the decision point: the only code that releases a step.
  // It does nothing unless the run has started, has not ended, and no step is
  // running; then it releases the step whose turn it is, if it has arrived.
  #releaseNext(): void {
    if (!this.#started || this.#ended || this.#running) {
      return;
    }
    if (this.#next === this.#order.length) {
      // Every entry ran: the run is complete.
      const trace = [...this.#trace];
      this.#end();
      this.#finish?.(trace);
      return;
    }
    const tag = this.#order[this.#next];
    const i = this.#parked.findIndex((p) => p.tag === tag); // that request's oldest waiting step
    if (i < 0) {
      return; // its step has not arrived yet; we are called again when it does
    }
    const [step] = this.#parked.splice(i, 1);
    step.unlisten();
    this.#next++;
    this.#running = true;
    step.release(this.#doneFor(step));
  }

  // #doneFor returns the DoneFn for a released step. Only its first call
  // counts, and none after the run has ended.
  #doneFor(step: Parked): DoneFn {
    let reported = false;
    return (status) => {
      if (reported || this.#ended) {
        return;
      }
      reported = true;
      this.#trace.push({ tag: step.tag, sql: step.sql, status });
      this.#running = false;
      this.#releaseNext();
    };
  }

  // #end stops the run for good: nothing parks any more, and every step still
  // waiting is let go unscheduled.
  #end(): void {
    this.#ended = true;
    this.#stopListening?.();
    for (const p of this.#parked.splice(0)) {
      p.unlisten();
      p.release(undefined);
    }
  }
}

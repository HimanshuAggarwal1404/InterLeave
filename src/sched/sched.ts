// Package sched, v1 (Phase 1): park tagged steps and release them, one at a
// time, in a hard-coded order. The spec is src/sched/sched.spec.ts (7 tests)
// and the Phase 1 exit test is victims/coupon/kill.spec.ts; run both with
//
//   npm run test:sched
//
// This file is a SKELETON: the types are final proposals (D-019, still open
// to change), every method throws "not implemented". The implementation
// replaces those throws.
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

const NOT_IMPLEMENTED = 'sched: not implemented';

export class Scheduler {
  // order lists request tags in release order. The n-th "A" in it means
  // request A's n-th tagged statement; the scheduler does not know A's
  // statements in advance, it counts them as they arrive.
  // Example (the coupon double-redeem): A, A, B, B, A, A, A, B, B, B.
  constructor(order: readonly string[]) {
    void order;
    throw new Error(NOT_IMPLEMENTED);
  }

  // onQuery has the shape of the proxy's hook (D-017). Wire it up with an
  // arrow function, (signal, tag, sql) => s.onQuery(signal, tag, sql),
  // because passing s.onQuery on its own would lose `this`.
  //
  // It must:
  // - resolve at once with undefined for an untagged query (tag "") or a tag
  //   the order never mentions (D-016), even before run() has started;
  // - otherwise park the step: keep the returned Promise pending until this
  //   step's turn in the order has come and the previous step has finished;
  //   then resolve with a DoneFn that reports this step's completion;
  // - settle (resolve or reject) soon after `signal` aborts, which happens
  //   when the step's connection goes away;
  // - never park once the order is used up or run() has ended: resolve at
  //   once from then on.
  // It is called for many connections whose calls interleave, so all of them
  // share the scheduler's state.
  onQuery(signal: AbortSignal, tag: string, sql: string): Promise<DoneFn | undefined> {
    void signal;
    void tag;
    void sql;
    throw new Error(NOT_IMPLEMENTED);
  }

  // run drives the order: release exactly one step at a time, the next only
  // after the previous step's DoneFn was called. It resolves with the trace
  // (each step with the status its DoneFn reported) once every entry of the
  // order has run. If `signal` aborts first, it rejects with
  // RunAbortedError(trace so far, signal.reason) and un-parks every waiting
  // step, so no proxy connection stays stuck.
  run(signal: AbortSignal): Promise<Step[]> {
    void signal;
    throw new Error(NOT_IMPLEMENTED);
  }
}

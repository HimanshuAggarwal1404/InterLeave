// RunScheduler, the Phase 2 scheduler: it controls one run of a scenario.
//
// Each request (A, B, ...) is in one of five states:
//   running    in app code, no statement parked (also right after its last
//              statement finished, until it sends the next or finishes)
//   parked     its next statement is held, waiting for a decision
//   executing  its statement was released and Postgres is working on it
//   blocked    waiting for a lock held by another request: Postgres says so
//              (probeBlocked, D-030), or, without a probe, it has been
//              executing for longer than the lock-wait timeout
//   finished   its HTTP response has arrived
//
// A decision point is reached when no request is executing, no request is
// running (or the quiet period has passed since the last event), and at least
// one is parked. A request that has not sent its first statement yet gets
// longer: up to the start grace, counted from the start of the run, because
// before its first statement the app may still be opening a database
// connection (which takes longer than the quiet period). Without it, the first
// decision would depend on connection timing, and the same scenario could be
// explored in a different order. Then the chooser picks which parked request goes next; that
// is how the explorer controls the order. Like v1 (sched.ts), all state lives
// in this object and one method, #evaluate, makes every decision; it runs
// after every event (a statement arrives or finishes, a request finishes, a
// timer fires).
//
// sched must not import networking code: tests drive it with fake requests.
import type { ReadyStatus } from '../pgwire/index.ts';

// StepResult is what a statement did (the proxy reads it from the reply).
// Same shape as the proxy's StepResult.
export type StepResult = {
  command?: string;
  firstValue?: string | null;
  error?: { code: string; message: string };
};

// RunDoneFn reports that a released statement has finished.
export type RunDoneFn = (status: ReadyStatus, result?: StepResult) => void;

// Chooser picks the request to release from the runnable (parked) ones, given
// in request order. The explorer supplies it: exhaustive, random or replay.
// next maps each runnable request to the SQL of its parked statement
// (partial-order reduction uses it, D-034; other choosers ignore it).
export type Chooser = (runnable: readonly string[], next: ReadonlyMap<string, string>) => string;

export type RequestState = 'running' | 'parked' | 'executing' | 'blocked' | 'finished';

// ExecutedStep is one released statement. status and result are missing if it
// never finished (the run was aborted while it was executing).
export type ExecutedStep = {
  tag: string;
  sql: string;
  status?: ReadyStatus;
  result?: StepResult;
  blocked: boolean; // it waited for a lock (probe) or outlived the lock-wait timeout
  blockedBy?: string[]; // the requests holding that lock, if the probe named them
};

// Decision is one choice: what was runnable, and what was released.
export type Decision = { runnable: string[]; chosen: string };

// RunTrace is how a run ended and what happened in it.
//   complete  every request finished
//   aborted   the run's signal aborted (run timeout, Ctrl+C); reason says why
//   error     the chooser failed (e.g. a replay found the app behaving
//             differently); reason is the error
export type RunTrace = {
  outcome: 'complete' | 'aborted' | 'error';
  reason?: unknown;
  steps: ExecutedStep[];
  decisions: Decision[];
};

export type RunSchedulerOptions = {
  requests: readonly string[]; // the tags fired in this run, in request order
  choose: Chooser;
  quietMs?: number; // default 50: how long a running request may delay a decision
  startGraceMs?: number; // default 1000: the same for a request's first statement, from the run's start
  lockWaitMs?: number; // default 200: when an executing statement counts as blocked (no probe)
  // probeBlocked, if set, asks Postgres which backend PIDs block the given
  // one ([] = not blocked): `SELECT pg_blocking_pids(pid)`. It is polled every
  // lockPollMs while a statement executes, instead of guessing with
  // lockWaitMs. Statements without a PID, or a probe that fails, fall back
  // to lockWaitMs.
  probeBlocked?: (pid: number) => Promise<number[]>;
  lockPollMs?: number; // default 10
  // beforeRelease, if set, is awaited before each release (replay --step).
  beforeRelease?: (step: { tag: string; sql: string }) => Promise<void>;
};

type Parked = {
  sql: string;
  pid: number | undefined; // the backend PID of the statement's connection
  release: (done: RunDoneFn | undefined) => void; // settles the statement's onQuery Promise
  unlisten: () => void; // removes its abort listener
};

type Request = {
  state: RequestState;
  sentFirst: boolean; // it has parked a statement in this run
  parked?: Parked;
  pid?: number; // backend PID of its latest statement: maps blocking PIDs to requests
  lockTimer?: NodeJS.Timeout; // lock-wait timeout, or the next probe
};

export class RunScheduler {
  readonly #order: readonly string[];
  readonly #requests = new Map<string, Request>();
  readonly #choose: Chooser;
  readonly #quietMs: number;
  readonly #lockWaitMs: number;
  readonly #probeBlocked: RunSchedulerOptions['probeBlocked'];
  readonly #lockPollMs: number;
  readonly #startGraceMs: number;
  readonly #beforeRelease: RunSchedulerOptions['beforeRelease'];
  #steps: ExecutedStep[] = [];
  #decisions: Decision[] = [];
  #started = false;
  #ended = false;
  #releasing = false; // waiting for beforeRelease: no other decision meanwhile
  #quietTimer: NodeJS.Timeout | undefined;
  #quietOver = false; // the quiet period passed with no event
  #graceTimer: NodeJS.Timeout | undefined;
  #graceOver = false; // the start grace passed
  #finish: ((trace: RunTrace) => void) | undefined;
  #stopListening: (() => void) | undefined;

  constructor(options: RunSchedulerOptions) {
    this.#order = [...options.requests];
    for (const tag of this.#order) {
      this.#requests.set(tag, { state: 'running', sentFirst: false });
    }
    this.#choose = options.choose;
    this.#quietMs = options.quietMs ?? 50;
    this.#lockWaitMs = options.lockWaitMs ?? 200;
    this.#probeBlocked = options.probeBlocked;
    this.#lockPollMs = options.lockPollMs ?? 10;
    this.#startGraceMs = options.startGraceMs ?? 1000;
    this.#beforeRelease = options.beforeRelease;
  }

  // onQuery is the proxy hook (D-017). A statement of a request in this run
  // that is running (in app code) is parked; anything else passes through at
  // once: untagged statements, unknown tags, a second statement while the
  // request already has one parked or executing, and everything after the run.
  onQuery(signal: AbortSignal, tag: string, sql: string, pid?: number): Promise<RunDoneFn | undefined> {
    const r = this.#requests.get(tag);
    if (r === undefined || r.state !== 'running' || this.#ended || signal.aborted) {
      return Promise.resolve(undefined);
    }
    return new Promise<RunDoneFn | undefined>((resolve) => {
      const step: Parked = { sql, pid, release: resolve, unlisten: () => {} };
      const onAbort = () => {
        // The statement's connection went away while it was parked.
        if (r.parked === step) {
          r.parked = undefined;
          r.state = 'running';
          resolve(undefined);
          this.#changed();
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      step.unlisten = () => signal.removeEventListener('abort', onAbort);
      r.parked = step;
      r.state = 'parked';
      r.sentFirst = true;
      if (pid !== undefined) {
        // Known as soon as it parks: a parked request in an open transaction
        // is exactly the kind that holds the lock another one waits for.
        r.pid = pid;
      }
      this.#changed();
    });
  }

  // requestFinished tells the scheduler a request's HTTP response arrived.
  requestFinished(tag: string): void {
    const r = this.#requests.get(tag);
    if (r === undefined || r.state === 'finished') {
      return;
    }
    clearTimeout(r.lockTimer);
    r.lockTimer = undefined;
    if (r.parked !== undefined) {
      r.parked.unlisten();
      r.parked.release(undefined);
      r.parked = undefined;
    }
    r.state = 'finished';
    this.#changed();
  }

  // run starts deciding and resolves when the run is over (it never rejects):
  // complete when every request finished, aborted when signal aborts, error if
  // the chooser fails. Every parked statement is let go when it ends.
  run(signal: AbortSignal): Promise<RunTrace> {
    if (this.#started) {
      return Promise.reject(new Error('sched: run() can only be called once'));
    }
    this.#started = true;
    return new Promise<RunTrace>((resolve) => {
      this.#finish = resolve;
      const onAbort = () => this.#end('aborted', signal.reason);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.#stopListening = () => signal.removeEventListener('abort', onAbort);
      this.#graceTimer = setTimeout(() => {
        this.#graceTimer = undefined;
        this.#graceOver = true;
        this.#evaluate();
      }, this.#startGraceMs);
      this.#evaluate();
    });
  }

  // #changed is called after every event: it restarts the quiet period (it
  // counts from the last event) and re-evaluates.
  #changed(): void {
    clearTimeout(this.#quietTimer);
    this.#quietTimer = undefined;
    this.#quietOver = false;
    this.#evaluate();
  }

  // #evaluate is the decision point: the only code that releases a statement.
  #evaluate(): void {
    if (!this.#started || this.#ended || this.#releasing) {
      return;
    }
    const states = this.#order.map((tag) => (this.#requests.get(tag) as Request).state);
    if (states.every((st) => st === 'finished')) {
      this.#end('complete');
      return;
    }
    if (states.includes('executing')) {
      return; // wait for its done, or for the lock-wait timeout
    }
    const runnable = this.#order.filter((tag) => this.#requests.get(tag)?.state === 'parked');
    if (runnable.length === 0) {
      return; // wait for a running request to park or finish, or a blocked one to finish
    }
    const running = this.#order.filter((tag) => this.#requests.get(tag)?.state === 'running');
    if (!this.#graceOver && running.some((tag) => !this.#requests.get(tag)?.sentFirst)) {
      return; // wait for its first statement, or for the start grace timer
    }
    if (running.length > 0 && !this.#quietOver) {
      // A request is in app code and may be about to send a statement that
      // should be part of this decision. Wait for it, but only up to the
      // quiet period: it may never send one (FR-10).
      if (this.#quietTimer === undefined) {
        this.#quietTimer = setTimeout(() => {
          this.#quietTimer = undefined;
          this.#quietOver = true;
          this.#evaluate();
        }, this.#quietMs);
      }
      return;
    }
    clearTimeout(this.#quietTimer);
    this.#quietTimer = undefined;

    let chosen: string;
    try {
      const next = new Map(runnable.map((tag) => [tag, (this.#requests.get(tag) as Request).parked?.sql ?? '']));
      chosen = this.#choose(runnable, next);
    } catch (err) {
      this.#end('error', err);
      return;
    }
    if (!runnable.includes(chosen)) {
      this.#end('error', new Error(`chooser picked ${JSON.stringify(chosen)}, which is not runnable (${runnable.join(', ')})`));
      return;
    }
    this.#decisions.push({ runnable, chosen });
    const r = this.#requests.get(chosen) as Request;
    const step = r.parked as Parked;
    if (this.#beforeRelease === undefined) {
      this.#release(chosen, r, step);
      return;
    }
    this.#releasing = true;
    this.#beforeRelease({ tag: chosen, sql: step.sql }).then(
      () => {
        this.#releasing = false;
        // Meanwhile the run may have ended or the statement's connection died.
        if (!this.#ended && r.parked === step) {
          this.#release(chosen, r, step);
        } else {
          this.#evaluate();
        }
      },
      (err: unknown) => {
        this.#releasing = false;
        this.#end('error', err);
      },
    );
  }

  // #release lets a parked statement go to Postgres and starts watching
  // whether it waits for a lock.
  #release(tag: string, r: Request, step: Parked): void {
    r.parked = undefined;
    step.unlisten();
    r.state = 'executing';
    const executed: ExecutedStep = { tag, sql: step.sql, blocked: false };
    this.#steps.push(executed);
    if (this.#probeBlocked !== undefined && step.pid !== undefined) {
      this.#pollLock(r, executed, step.pid, this.#probeBlocked);
    } else {
      this.#startLockTimeout(r, executed);
    }
    step.release(this.#doneFor(r, executed));
  }

  // #startLockTimeout: no reply within the lock-wait timeout most likely means
  // the statement waits for a row lock that another, parked request holds.
  // Then let the others go on (D-007).
  #startLockTimeout(r: Request, executed: ExecutedStep): void {
    r.lockTimer = setTimeout(() => {
      r.lockTimer = undefined;
      if (r.state === 'executing') {
        this.#markBlocked(r, executed);
      }
    }, this.#lockWaitMs);
  }

  // #pollLock asks Postgres every lockPollMs whether the statement waits for
  // a lock (D-030). One probe at a time: the next is scheduled only after the
  // previous answered. It stops when the statement finishes or is blocked;
  // an answer that arrives after that is ignored.
  #pollLock(r: Request, executed: ExecutedStep, pid: number, probe: (pid: number) => Promise<number[]>): void {
    const stillWaiting = () => !this.#ended && r.state === 'executing' && this.#steps.at(-1) === executed;
    r.lockTimer = setTimeout(() => {
      r.lockTimer = undefined;
      if (!stillWaiting()) {
        return;
      }
      probe(pid).then(
        (blockers) => {
          if (!stillWaiting()) {
            return;
          }
          if (blockers.length > 0) {
            executed.blockedBy = this.#order.filter((tag) => {
              const other = this.#requests.get(tag);
              return other !== r && other?.pid !== undefined && blockers.includes(other.pid);
            });
            this.#markBlocked(r, executed);
          } else {
            this.#pollLock(r, executed, pid, probe);
          }
        },
        () => {
          // The probe itself failed (e.g. the admin connection broke): fall
          // back to the timeout for this statement.
          if (stillWaiting()) {
            this.#startLockTimeout(r, executed);
          }
        },
      );
    }, this.#lockPollMs);
  }

  #markBlocked(r: Request, executed: ExecutedStep): void {
    r.state = 'blocked';
    executed.blocked = true;
    this.#changed();
  }

  // #doneFor returns the done function for a released statement. Only its
  // first call counts.
  #doneFor(r: Request, executed: ExecutedStep): RunDoneFn {
    let reported = false;
    return (status, result) => {
      if (reported) {
        return;
      }
      reported = true;
      clearTimeout(r.lockTimer);
      r.lockTimer = undefined;
      executed.status = status;
      if (result !== undefined) {
        executed.result = result;
      }
      if (this.#ended) {
        return;
      }
      if (r.state === 'executing' || r.state === 'blocked') {
        r.state = 'running';
      }
      this.#changed();
    };
  }

  // #end stops the run for good: timers are cleared, every parked statement
  // is let go unscheduled, and run() resolves with the trace.
  #end(outcome: RunTrace['outcome'], reason?: unknown): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    clearTimeout(this.#quietTimer);
    this.#quietTimer = undefined;
    clearTimeout(this.#graceTimer);
    this.#graceTimer = undefined;
    this.#stopListening?.();
    for (const r of this.#requests.values()) {
      clearTimeout(r.lockTimer);
      r.lockTimer = undefined;
      if (r.parked !== undefined) {
        r.parked.unlisten();
        r.parked.release(undefined);
        r.parked = undefined;
      }
    }
    this.#finish?.({
      outcome,
      ...(reason === undefined ? {} : { reason }),
      steps: this.#steps.map((s) => ({ ...s })),
      decisions: this.#decisions.map((d) => ({ runnable: [...d.runnable], chosen: d.chosen })),
    });
  }
}

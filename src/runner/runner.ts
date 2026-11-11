// Package runner orchestrates runs (ARCHITECTURE section 4): reset the
// database, fire the requests, let the scheduler and a strategy choose the
// order, judge the result with the oracle, record it, and repeat.
import net from 'node:net';
import { PgProxy, splitHostPort } from '../proxy/index.ts';
import { fireRequests } from '../harness/index.ts';
import { checkInvariants } from '../oracle/index.ts';
import { AdminDb } from '../reset/index.ts';
import { Exhaustive, RandomStrategy, replayChooser } from '../explore/index.ts';
import { RunScheduler, type Chooser } from '../sched/run.ts';
import type { Scenario } from '../scenario/index.ts';
import type { ExploreSummary, FindingKind, RunResult, Strategy } from './types.ts';

export type TimingOptions = {
  quietMs: number; // FR-10, default 50
  lockWaitMs: number; // FR-11, default 200
  runTimeoutMs: number; // FR-12, default 10 s
  startGraceMs?: number; // how long a request's first statement may delay a decision; default 1 s
};

export const DEFAULT_TIMING: TimingOptions = { quietMs: 50, lockWaitMs: 200, runTimeoutMs: 10_000 };

export type ExploreOptions = TimingOptions & {
  strategy: Strategy;
  seed: number;
  maxRuns: number;
  all: boolean; // keep going after a finding and report every distinct one (FR-16)
  signal?: AbortSignal; // Ctrl+C: stop after the current run
  onRun?: (result: RunResult) => void; // progress
};

// Engine owns the in-process proxy (D-002: the proxy runs inside `interleave
// run`, so scheduler and proxy share memory). Between runs, and for anything
// untagged, the proxy just forwards.
export class Engine {
  readonly #proxy: PgProxy;
  readonly #server: net.Server;
  readonly #stop = new AbortController();
  readonly #served: Promise<void>;
  readonly #address: string; // kept: a closed server no longer has one
  #current: RunScheduler | undefined;

  private constructor(proxy: PgProxy, server: net.Server) {
    this.#proxy = proxy;
    this.#server = server;
    const a = server.address() as net.AddressInfo;
    this.#address = a.family === 'IPv6' ? `[${a.address}]:${a.port}` : `${a.address}:${a.port}`;
    proxy.onQuery = (signal, tag, sql) => this.#current?.onQuery(signal, tag, sql);
    this.#served = proxy.serve(server, this.#stop.signal);
  }

  // start listens on listen ("127.0.0.1:6433"; port 0 picks a free one) and
  // forwards to upstream, which must be the local Postgres.
  static async start(listen: string, upstream: string): Promise<Engine> {
    const proxy = new PgProxy(upstream);
    const { host, port } = splitHostPort(listen);
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host === '' ? undefined : host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return new Engine(proxy, server);
  }

  // proxyAddress is where apps must connect, e.g. "127.0.0.1:6433".
  get proxyAddress(): string {
    return this.#address;
  }

  async close(): Promise<void> {
    this.#stop.abort();
    await this.#served;
  }

  // explore runs the scenario again and again under the chosen strategy until
  // a finding (or, with all, until done), every order is checked, --max-runs
  // is reached, or the signal aborts.
  async explore(scenario: Scenario, opts: ExploreOptions): Promise<ExploreSummary> {
    const summary: ExploreSummary = {
      scenarioName: scenario.name,
      scenarioFile: scenario.file,
      strategy: opts.strategy,
      seed: opts.seed,
      maxRuns: opts.maxRuns,
      runs: 0,
      complete: false,
      findings: [],
      interrupted: false,
      seconds: 0,
      resetSeconds: 0,
    };
    const started = performance.now();
    const exhaustive = opts.strategy === 'exhaustive' ? new Exhaustive() : undefined;
    const random = opts.strategy === 'random' ? new RandomStrategy(opts.seed) : undefined;
    const seen = new Set<string>(); // finding signatures already reported
    const admin = await AdminDb.connect(scenario.adminDsn);
    try {
      while (summary.runs < opts.maxRuns) {
        if (opts.signal?.aborted) {
          summary.interrupted = true;
          break;
        }
        const chooser = exhaustive !== undefined ? exhaustive.nextChooser() : random?.nextChooser();
        if (chooser === undefined) {
          break; // exhaustive: every order explored
        }
        const result = await this.#runOnce(scenario, admin, chooser, summary.runs + 1, opts);
        summary.runs++;
        summary.resetSeconds += result.resetMs / 1000;
        exhaustive?.record(result.trace.decisions);
        opts.onRun?.(result);
        if (result.outcome === 'error') {
          summary.error = result.error;
          break;
        }
        const broken = result.invariants.find((i) => i.error !== undefined);
        if (broken !== undefined) {
          summary.error = `invariant "${broken.name}" could not be checked: ${broken.error}`;
          break;
        }
        if (summary.runs === 1 && result.trace.decisions.length === 0) {
          summary.error =
            'no tagged statement reached the proxy in the first run: is the app\'s database URL pointed at ' +
            `${this.proxyAddress}, and does it put the X-Interleave-Req tag into its SQL?`;
          break;
        }
        if (result.findings.length > 0) {
          const signature = findingSignature(result);
          if (!seen.has(signature)) {
            seen.add(signature);
            summary.findings.push(result);
            if (summary.firstFindingAfterRuns === undefined) {
              summary.firstFindingAfterRuns = summary.runs;
              summary.firstFindingAfterSeconds = (performance.now() - started) / 1000;
            }
          }
          if (!opts.all) {
            break;
          }
        }
      }
      summary.complete = exhaustive?.done ?? false;
    } finally {
      await admin.close();
      summary.seconds = (performance.now() - started) / 1000;
    }
    return summary;
  }

  // replay runs the scenario once with the recorded choices (FR-22).
  // beforeRelease, if set, is awaited before each statement goes (--step).
  async replay(
    scenario: Scenario,
    choices: readonly string[],
    opts: TimingOptions & { beforeRelease?: (step: { tag: string; sql: string }) => Promise<void> },
  ): Promise<RunResult> {
    const admin = await AdminDb.connect(scenario.adminDsn);
    try {
      return await this.#runOnce(scenario, admin, replayChooser(choices), 1, opts);
    } finally {
      await admin.close();
    }
  }

  // #runOnce: reset, fire, schedule, judge.
  async #runOnce(
    scenario: Scenario,
    admin: AdminDb,
    choose: Chooser,
    index: number,
    opts: TimingOptions & { beforeRelease?: (step: { tag: string; sql: string }) => Promise<void> },
  ): Promise<RunResult> {
    const started = performance.now();
    const resetMs = await admin.reset(scenario.resetSql);
    const sched = new RunScheduler({
      requests: scenario.requests.map((r) => r.tag),
      choose,
      quietMs: opts.quietMs,
      lockWaitMs: opts.lockWaitMs,
      ...(opts.startGraceMs === undefined ? {} : { startGraceMs: opts.startGraceMs }),
      ...(opts.beforeRelease === undefined ? {} : { beforeRelease: opts.beforeRelease }),
    });
    this.#current = sched;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`run timeout (${opts.runTimeoutMs} ms)`)), opts.runTimeoutMs);
    try {
      const run = sched.run(timeout.signal);
      const responses = fireRequests(scenario.baseUrl, scenario.requests, {
        finished: (tag) => sched.requestFinished(tag),
        timeoutMs: opts.runTimeoutMs + 5000,
      });
      // Wait for both: the scheduler's end and every HTTP response. After a
      // timeout the scheduler lets every parked statement go, so the requests
      // finish too; waiting for them keeps runs from overlapping (D-005).
      const [trace, resps] = await Promise.all([run, responses]);
      const invariants = await checkInvariants(admin.client, scenario.invariants);
      const findings: FindingKind[] = [];
      if (invariants.some((i) => !i.ok && i.error === undefined)) {
        findings.push('invariant');
      }
      if (trace.steps.some((s) => s.result?.error?.code === '40P01')) {
        findings.push('deadlock');
      }
      const outcome = trace.outcome === 'complete' ? 'complete' : trace.outcome === 'aborted' ? 'timeout' : 'error';
      const result: RunResult = {
        index,
        outcome,
        trace,
        responses: resps,
        invariants,
        findings,
        resetMs,
        ms: performance.now() - started,
      };
      if (outcome === 'error') {
        result.error = trace.reason instanceof Error ? trace.reason.message : String(trace.reason);
      }
      return result;
    } finally {
      clearTimeout(timer);
      this.#current = undefined;
    }
  }
}

// findingSignature identifies a kind of finding, so --all reports each
// distinct one once: which kinds, and which invariants broke.
function findingSignature(r: RunResult): string {
  const broken = r.invariants.filter((i) => !i.ok).map((i) => i.name);
  return JSON.stringify([r.findings, broken]);
}

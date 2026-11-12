// Package runner orchestrates runs (ARCHITECTURE section 4): reset the
// database, fire the requests, let the scheduler and a strategy choose the
// order, judge the result with the oracle, record it, and repeat.
import net from 'node:net';
import { PgProxy, splitHostPort } from '../proxy/index.ts';
import { fireRequests } from '../harness/index.ts';
import { SerialOracle, checkInvariants, serialOrders, snapshot, type Outcome } from '../oracle/index.ts';
import { AdminDb } from '../reset/index.ts';
import { Exhaustive, PctStrategy, RandomStrategy, replayChooser, shrink, switches } from '../explore/index.ts';
import { RunScheduler, type Chooser } from '../sched/run.ts';
import type { Scenario } from '../scenario/index.ts';
import type { ExploreSummary, FindingKind, RunResult, Strategy } from './types.ts';

// LockDetect: how a statement waiting for a lock is noticed (D-030).
//   pg       ask Postgres (pg_blocking_pids) every lockPollMs: exact
//   timeout  no reply within lockWaitMs counts as blocked (D-007, the MVP way)
export type LockDetect = 'pg' | 'timeout';

export type TimingOptions = {
  quietMs: number; // FR-10, default 50
  lockWaitMs: number; // FR-11, default 200 (timeout mode, and the fallback without a PID)
  lockDetect?: LockDetect; // default 'pg'
  lockPollMs?: number; // default 10
  runTimeoutMs: number; // FR-12, default 10 s
  startGraceMs?: number; // how long a request's first statement may delay a decision; default 1 s
};

export const DEFAULT_TIMING: TimingOptions = { quietMs: 50, lockWaitMs: 200, runTimeoutMs: 10_000 };

export type ExploreOptions = TimingOptions & {
  strategy: Strategy;
  seed: number;
  depth?: number; // pct: the number of preemptions it aims for, minus one change point each (default 2)
  maxRuns: number;
  all: boolean; // keep going after a finding and report every distinct one (FR-16)
  shrink?: boolean; // default true: simplify each finding to fewer switches (D-033)
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
    proxy.onQuery = (signal, tag, sql, pid) => this.#current?.onQuery(signal, tag, sql, pid);
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
      ...(opts.strategy === 'pct' ? { depth: opts.depth ?? 2 } : {}),
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
    const random =
      opts.strategy === 'random' ? new RandomStrategy(opts.seed) : opts.strategy === 'pct' ? new PctStrategy(opts.seed, opts.depth ?? 2) : undefined;
    const seen = new Set<string>(); // finding signatures already reported
    const admin = await AdminDb.connect(scenario.adminDsn);
    try {
      let oracle: SerialOracle | undefined;
      try {
        oracle = await this.#serialOracle(scenario, admin);
      } catch (err) {
        summary.error = (err as Error).message;
        return summary;
      }
      if (oracle !== undefined) {
        summary.serialOrders = oracle.outcomes.length;
      }
      while (summary.runs < opts.maxRuns) {
        if (opts.signal?.aborted) {
          summary.interrupted = true;
          break;
        }
        const chooser = exhaustive !== undefined ? exhaustive.nextChooser() : random?.nextChooser();
        if (chooser === undefined) {
          break; // exhaustive: every order explored
        }
        const result = await this.#runOnce(scenario, admin, chooser, summary.runs + 1, opts, oracle);
        summary.runs++;
        summary.resetSeconds += result.resetMs / 1000;
        exhaustive?.record(result.trace.decisions);
        if (random instanceof PctStrategy) {
          random.record(result.trace.decisions);
        }
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
            if (summary.firstFindingAfterRuns === undefined) {
              summary.firstFindingAfterRuns = summary.runs;
              summary.firstFindingAfterSeconds = (performance.now() - started) / 1000;
            }
            let reported = result;
            if (opts.shrink !== false) {
              reported = await this.#shrinkFinding(scenario, admin, result, opts, oracle);
              summary.shrinkRuns = (summary.shrinkRuns ?? 0) + (reported.shrunk?.attempts ?? 0);
            }
            summary.findings.push(reported);
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
      const oracle = await this.#serialOracle(scenario, admin);
      return await this.#runOnce(scenario, admin, replayChooser(choices), 1, opts, oracle);
    } finally {
      await admin.close();
    }
  }

  // #shrinkFinding simplifies a finding (D-033): the shrinker proposes orders
  // with fewer switches, each is really run, and one counts only if it shows
  // the same bug (same finding kinds and broken invariants). Returns the run
  // with the fewest switches, with shrunk set.
  async #shrinkFinding(
    scenario: Scenario,
    admin: AdminDb,
    found: RunResult,
    opts: TimingOptions,
    oracle: SerialOracle | undefined,
  ): Promise<RunResult> {
    const signature = findingSignature(found);
    const original = found.trace.decisions.map((d) => d.chosen);
    let best = found;
    const { choices, attempts } = await shrink(original, async (choose) => {
      const r = await this.#runOnce(scenario, admin, choose, found.index, opts, oracle);
      if (r.outcome !== 'complete' || findingSignature(r) !== signature) {
        return undefined;
      }
      const tried = r.trace.decisions.map((d) => d.chosen);
      if (switches(tried) < switches(best.trace.decisions.map((d) => d.chosen))) {
        best = r;
      }
      return r.trace.decisions;
    });
    return {
      ...best,
      shrunk: { fromRun: found.index, fromSwitches: switches(original), toSwitches: switches(choices), attempts },
    };
  }

  // #serialOracle runs the requests one at a time in every order (D-031) and
  // records each outcome; undefined if the scenario has no serial section.
  // Nothing is scheduled meanwhile (#current is unset), and each request is
  // fired only after the previous one answered, so these runs really are
  // serial.
  async #serialOracle(scenario: Scenario, admin: AdminDb): Promise<SerialOracle | undefined> {
    if (scenario.serial === undefined) {
      return undefined;
    }
    const oracle = new SerialOracle();
    for (const order of serialOrders(scenario.requests.map((r) => r.tag))) {
      await admin.reset(scenario.resetSql);
      const statuses: Record<string, number> = {};
      for (const tag of order) {
        const request = scenario.requests.find((r) => r.tag === tag);
        if (request === undefined) {
          continue;
        }
        const [res] = await fireRequests(scenario.baseUrl, [request]);
        if (res.error !== undefined) {
          throw new Error(`serial run ${order.join(' then ')}: request ${tag} failed: ${res.error}`);
        }
        statuses[tag] = res.status;
      }
      oracle.record(order, { tables: await snapshot(admin.client, scenario.serial), statuses });
    }
    return oracle;
  }

  // #runOnce: reset, fire, schedule, judge.
  async #runOnce(
    scenario: Scenario,
    admin: AdminDb,
    choose: Chooser,
    index: number,
    opts: TimingOptions & { beforeRelease?: (step: { tag: string; sql: string }) => Promise<void> },
    oracle?: SerialOracle,
  ): Promise<RunResult> {
    const started = performance.now();
    const resetMs = await admin.reset(scenario.resetSql);
    const sched = new RunScheduler({
      requests: scenario.requests.map((r) => r.tag),
      choose,
      quietMs: opts.quietMs,
      lockWaitMs: opts.lockWaitMs,
      ...(opts.startGraceMs === undefined ? {} : { startGraceMs: opts.startGraceMs }),
      ...(opts.lockDetect === 'timeout' ? {} : { probeBlocked: (pid: number) => admin.blockingPids(pid) }),
      ...(opts.lockPollMs === undefined ? {} : { lockPollMs: opts.lockPollMs }),
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
      let serial: RunResult['serial'];
      let serialError: string | undefined;
      // Only a completed run is judged: a timed-out one stopped halfway
      // (FR-12: a timeout is reported, not a violation).
      if (oracle !== undefined && scenario.serial !== undefined && trace.outcome === 'complete') {
        try {
          const now: Outcome = {
            tables: await snapshot(admin.client, scenario.serial),
            statuses: Object.fromEntries(resps.map((r) => [r.tag, r.status])),
          };
          const matched = oracle.match(now);
          serial = { outcome: now, ...(matched === undefined ? {} : { matched }), serialOutcomes: oracle.outcomes };
          if (matched === undefined) {
            findings.push('serial');
          }
        } catch (err) {
          serialError = (err as Error).message;
        }
      }
      const outcome =
        serialError !== undefined ? 'error' : trace.outcome === 'complete' ? 'complete' : trace.outcome === 'aborted' ? 'timeout' : 'error';
      const result: RunResult = {
        index,
        outcome,
        trace,
        responses: resps,
        invariants,
        ...(serial === undefined ? {} : { serial }),
        findings,
        resetMs,
        ms: performance.now() - started,
      };
      if (serialError !== undefined) {
        result.error = serialError;
      } else if (outcome === 'error') {
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

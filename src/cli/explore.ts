// The `interleave run` and `interleave replay` commands.
import http from 'node:http';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_TIMING, Engine, type RunResult, type Strategy, type TimingOptions } from '../runner/index.ts';
import { ScenarioError, loadScenario, type Scenario } from '../scenario/index.ts';
import { describeFindings, formatSummary, formatTimeline, readSchedule, stripTag, toScheduleFile, writeSchedule } from '../report/index.ts';
import { parseDuration } from '../duration.ts';
import { errorMessage } from '../log.ts';
import { EXIT_FOUND, EXIT_INTERNAL, EXIT_OK, EXIT_USAGE } from './exit.ts';

export const runUsage = `  interleave run <scenario.yaml> [--strategy exhaustive|random] [--max-runs 1000] [--seed 1]
                 [--all] [--out .interleave] [--listen 127.0.0.1:6433] [--upstream 127.0.0.1:5432]
                 [--lock-wait 200ms] [--quiet 50ms] [--run-timeout 10s]
      try orders of the scenario's requests until an invariant breaks; the app must
      already run with its database URL pointed at --listen
  interleave replay <schedule.json> [--step] [--listen ...] [--upstream ...]
      run one saved order again; --step waits for Enter before each statement`;

// Flags shared by run and replay.
const commonOptions = {
  listen: { type: 'string', default: '127.0.0.1:6433' },
  upstream: { type: 'string', default: '127.0.0.1:5432' },
  'lock-wait': { type: 'string', default: '200ms' },
  quiet: { type: 'string', default: '50ms' },
  'run-timeout': { type: 'string', default: '10s' },
} as const;

function timing(values: { 'lock-wait': string; quiet: string; 'run-timeout': string }): TimingOptions {
  return {
    lockWaitMs: parseDuration(values['lock-wait']),
    quietMs: parseDuration(values.quiet),
    runTimeoutMs: parseDuration(values['run-timeout']),
  };
}

// runExplore is `interleave run`.
export async function runExplore(args: string[], signal?: AbortSignal): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        ...commonOptions,
        strategy: { type: 'string', default: 'exhaustive' },
        'max-runs': { type: 'string', default: '1000' },
        seed: { type: 'string', default: '1' },
        all: { type: 'boolean', default: false },
        out: { type: 'string', default: '.interleave' },
      },
    });
  } catch (err) {
    return usageError(errorMessage(err));
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) {
    return usageError('run needs exactly one scenario file');
  }
  const strategy = values.strategy as Strategy;
  const maxRuns = Number(values['max-runs']);
  const seed = Number(values.seed);
  if (strategy !== 'exhaustive' && strategy !== 'random') {
    return usageError('--strategy must be exhaustive or random');
  }
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || !Number.isInteger(seed)) {
    return usageError('--max-runs must be an integer >= 1 and --seed an integer');
  }
  let times: TimingOptions;
  try {
    times = timing(values);
  } catch (err) {
    return usageError(errorMessage(err));
  }

  const setup = await prepare(positionals[0], values.listen, values.upstream);
  if (typeof setup === 'number') {
    return setup;
  }
  const { scenario, engine } = setup;
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once('SIGINT', onStop);
  signal?.addEventListener('abort', onStop, { once: true });
  try {
    console.log(`interleave: ${scenario.name}: ${scenario.requests.length} requests, strategy ${strategy}${strategy === 'random' ? ` (seed ${seed})` : ''}, up to ${maxRuns} runs`);
    console.log(`  app ${scenario.baseUrl} must use the database at ${engine.proxyAddress}`);
    let summary;
    try {
      summary = await engine.explore(scenario, {
        ...times,
        strategy,
        seed,
        maxRuns,
        all: values.all,
        signal: stop.signal,
        onRun: (r) => progress(r),
      });
    } catch (err) {
      console.error(`interleave: ${errorMessage(err)}`);
      return EXIT_INTERNAL;
    }
    for (const found of summary.findings) {
      const file = await writeSchedule(values.out, toScheduleFile(summary, found));
      console.log(`\nFOUND in run ${found.index}: ${describeFindings(found)}\n`);
      console.log(formatTimeline(found, scenario.requests));
      console.log(`\nReplay: interleave replay ${file.replaceAll('\\', '/')}`);
    }
    console.log(`\n${formatSummary(summary)}`);
    if (summary.error !== undefined) {
      return EXIT_INTERNAL;
    }
    return summary.findings.length > 0 ? EXIT_FOUND : EXIT_OK;
  } finally {
    process.off('SIGINT', onStop);
    signal?.removeEventListener('abort', onStop);
    await engine.close();
  }
}

// runReplay is `interleave replay`: one run with the saved choices.
export async function runReplay(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { ...commonOptions, step: { type: 'boolean', default: false } } });
  } catch (err) {
    return usageError(errorMessage(err));
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) {
    return usageError('replay needs exactly one schedule file');
  }
  let times: TimingOptions;
  let file;
  try {
    times = timing(values);
    file = await readSchedule(positionals[0]);
  } catch (err) {
    return usageError(errorMessage(err));
  }
  const setup = await prepare(file.scenario, values.listen, values.upstream);
  if (typeof setup === 'number') {
    return setup;
  }
  const { scenario, engine } = setup;
  const rl = values.step ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  try {
    console.log(`interleave: replaying run ${file.run} of ${file.name} (${file.choices.length} decisions)`);
    let result: RunResult;
    try {
      result = await engine.replay(scenario, file.choices, {
        ...times,
        ...(rl === undefined
          ? {}
          : {
              beforeRelease: async (step: { tag: string; sql: string }) => {
                await rl.question(`next: [${step.tag}] ${stripTag(step.sql)}   (Enter to run it) `);
              },
            }),
      });
    } catch (err) {
      console.error(`interleave: ${errorMessage(err)}`);
      return EXIT_INTERNAL;
    }
    console.log(`\n${formatTimeline(result, scenario.requests)}\n`);
    if (result.outcome === 'error') {
      console.log(`Replay failed: ${result.error}`);
      return EXIT_INTERNAL;
    }
    if (result.findings.length > 0) {
      const same = JSON.stringify(result.findings) === JSON.stringify(file.findings);
      console.log(`${same ? 'Reproduced' : 'Different finding'}: ${describeFindings(result)}`);
      return EXIT_FOUND;
    }
    console.log('No violation: this order no longer breaks the invariants (fixed?).');
    return EXIT_OK;
  } finally {
    rl?.close();
    await engine.close();
  }
}

// prepare loads the scenario, starts the engine and checks the app answers.
// It returns an exit code instead when something is wrong.
async function prepare(scenarioPath: string, listen: string, upstream: string): Promise<{ scenario: Scenario; engine: Engine } | number> {
  let scenario: Scenario;
  try {
    scenario = await loadScenario(scenarioPath);
  } catch (err) {
    console.error(`interleave: ${errorMessage(err)}`);
    return err instanceof ScenarioError ? EXIT_USAGE : EXIT_INTERNAL;
  }
  let engine: Engine;
  try {
    engine = await Engine.start(listen, upstream);
  } catch (err) {
    return usageError(`cannot start the proxy on ${listen}: ${errorMessage(err)}`);
  }
  if (!(await reachable(scenario.baseUrl))) {
    await engine.close();
    console.error(`interleave: the app at ${scenario.baseUrl} does not answer. Start it first, with its database URL pointed at ${engine.proxyAddress}.`);
    return EXIT_USAGE;
  }
  return { scenario, engine };
}

// reachable reports whether anything answers HTTP at baseUrl (any status).
function reachable(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}/`, { agent: false, timeout: 3000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
  });
}

function progress(r: RunResult): void {
  if (r.findings.length > 0 || r.outcome !== 'complete' || r.index % 25 === 0) {
    const what = r.findings.length > 0 ? describeFindings(r) : r.outcome === 'complete' ? 'clean' : `${r.outcome}${r.error === undefined ? '' : `: ${r.error}`}`;
    console.error(`  run ${r.index}: ${what}`);
  }
}

function usageError(message: string): number {
  console.error(`interleave: ${message}\nusage:\n${runUsage}`);
  return EXIT_USAGE;
}


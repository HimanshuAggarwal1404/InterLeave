// Compares exhaustive, random and PCT on the ledger benchmark victim (D-032):
// how many runs (and seconds) each needs to find the lost fee. Random and PCT
// run with seeds 1..SEEDS; the fixed ledger must stay clean under all three.
// Needs the local Postgres. Usage: node scripts/compare-strategies.ts [seeds]
// Writes .interleave/strategies.json for docs/RESULTS.md.
import http from 'node:http';
import type net from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { newPool } from '../victims/common/kit.ts';
import { newHandler } from '../victims/ledger/app.ts';
import { DEFAULT_TIMING, Engine, type ExploreSummary } from '../src/runner/index.ts';
import type { Strategy } from '../src/runner/types.ts';
import { loadScenario } from '../src/scenario/index.ts';

const SEEDS = Number(process.argv[2] ?? 10);
const MAX_RUNS = 2000;

async function withLedger<T>(fixed: boolean, work: (engine: Engine, baseUrl: string) => Promise<T>): Promise<T> {
  const engine = await Engine.start('127.0.0.1:0', '127.0.0.1:5432');
  const pool = newPool(`postgres://interleave:interleave@${engine.proxyAddress}/interleave?sslmode=disable`);
  const server = http.createServer(newHandler(pool, fixed));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    return await work(engine, `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await pool.end();
    await engine.close();
  }
}

const file = fileURLToPath(new URL('../victims/ledger/scenario.yaml', import.meta.url));
const scenario = await loadScenario(file);

async function explore(fixed: boolean, strategy: Strategy, seed: number, maxRuns = MAX_RUNS): Promise<ExploreSummary> {
  return withLedger(fixed, (engine, baseUrl) =>
    engine.explore({ ...scenario, baseUrl }, { ...DEFAULT_TIMING, strategy, seed, depth: 2, maxRuns, all: false }),
  );
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const results: Record<string, unknown> = { when: new Date().toISOString(), seeds: SEEDS, maxRuns: MAX_RUNS };
const rows: string[] = [];

const ex = await explore(false, 'exhaustive', 1);
results['exhaustive'] = { runs: ex.firstFindingAfterRuns ?? null, seconds: ex.firstFindingAfterSeconds ?? null };
rows.push(`exhaustive        first violation at run ${ex.firstFindingAfterRuns ?? `none in ${ex.runs}`} (${ex.firstFindingAfterSeconds?.toFixed(2) ?? '-'} s)`);

for (const strategy of ['random', 'pct'] as const) {
  const runs: number[] = [];
  const secs: number[] = [];
  let missed = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = await explore(false, strategy, seed);
    if (s.error !== undefined) {
      throw new Error(`${strategy} seed ${seed}: ${s.error}`);
    }
    if (s.firstFindingAfterRuns === undefined) {
      missed++;
      runs.push(MAX_RUNS);
      secs.push(s.seconds);
    } else {
      runs.push(s.firstFindingAfterRuns);
      secs.push(s.firstFindingAfterSeconds ?? s.seconds);
    }
    process.stderr.write(`  ${strategy} seed ${seed}: ${s.firstFindingAfterRuns ?? 'none'}\n`);
  }
  results[strategy] = { runsPerSeed: runs, medianRuns: median(runs), medianSeconds: median(secs), missed };
  rows.push(
    `${strategy.padEnd(17)} median ${median(runs)} runs (min ${Math.min(...runs)}, max ${Math.max(...runs)}), median ${median(secs).toFixed(2)} s, missed ${missed}/${SEEDS}`,
  );
}

// The fixed ledger: no strategy may report anything.
const fixedChecks = [await explore(true, 'exhaustive', 1, 1000), await explore(true, 'random', 1, 300), await explore(true, 'pct', 1, 300)];
results['fixed'] = fixedChecks.map((s) => ({ strategy: s.strategy, runs: s.runs, complete: s.complete, findings: s.findings.length, error: s.error ?? null }));
rows.push(`fixed ledger      ${fixedChecks.map((s) => `${s.strategy} ${s.runs} runs: ${s.findings.length === 0 && s.error === undefined ? 'clean' : 'FOUND SOMETHING'}`).join('; ')}`);

const dir = fileURLToPath(new URL('../.interleave/', import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(`${dir}strategies.json`, `${JSON.stringify(results, null, 2)}\n`);
console.log(rows.join('\n'));
if (fixedChecks.some((s) => s.findings.length > 0 || s.error !== undefined)) {
  process.exitCode = 1;
}

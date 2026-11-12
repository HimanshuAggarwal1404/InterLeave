// Measures partial-order reduction (D-034): for every victim's fixed variant,
// a complete exhaustive exploration with and without --por (runs, runs cut
// short, seconds), and both must report no violation; and for every buggy
// variant, exhaustive search with --por must still find the race.
// Needs the local Postgres. Usage: node scripts/measure-por.ts
// Writes .interleave/por.json for docs/RESULTS.md.
import http from 'node:http';
import type net from 'node:net';
import type pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { newPool } from '../victims/common/kit.ts';
import { newHandler as approval } from '../victims/approval/app.ts';
import { newHandler as coupon } from '../victims/coupon/app.ts';
import { newHandler as counter } from '../victims/counter/app.ts';
import { newHandler as inventory } from '../victims/inventory/app.ts';
import { newHandler as ledger } from '../victims/ledger/app.ts';
import { newHandler as seat } from '../victims/seat/app.ts';
import { newHandler as transfer } from '../victims/transfer/app.ts';
import { newHandler as username } from '../victims/username/app.ts';
import { newHandler as wallet } from '../victims/wallet/app.ts';
import { DEFAULT_TIMING, Engine, type ExploreSummary } from '../src/runner/index.ts';
import { loadScenario } from '../src/scenario/index.ts';

type NewHandler = (pool: pg.Pool, fixed: boolean) => http.RequestListener;
const VICTIMS: Array<[string, NewHandler]> = [
  ['coupon', coupon],
  ['inventory', inventory],
  ['seat', seat],
  ['wallet', wallet],
  ['username', username],
  ['transfer', transfer],
  ['approval', approval],
  ['counter', counter],
  ['ledger', ledger],
];
const MAX_RUNS = 5000;

async function explore(name: string, newHandler: NewHandler, por: boolean, fixed = true): Promise<ExploreSummary> {
  const engine = await Engine.start('127.0.0.1:0', '127.0.0.1:5432');
  const pool = newPool(`postgres://interleave:interleave@${engine.proxyAddress}/interleave?sslmode=disable`);
  const server = http.createServer(newHandler(pool, fixed));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const scenario = await loadScenario(fileURLToPath(new URL(`../victims/${name}/scenario.yaml`, import.meta.url)));
    const baseUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    return await engine.explore({ ...scenario, baseUrl }, { ...DEFAULT_TIMING, strategy: 'exhaustive', seed: 1, maxRuns: MAX_RUNS, all: false, por });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await pool.end();
    await engine.close();
  }
}

const only = process.argv.slice(2);
const results: Record<string, unknown> = { when: new Date().toISOString(), maxRuns: MAX_RUNS };
const rows: string[] = [];
let bad = false;
for (const [name, newHandler] of VICTIMS) {
  if (only.length > 0 && !only.includes(name)) {
    continue;
  }
  const full = await explore(name, newHandler, false);
  const reduced = await explore(name, newHandler, true);
  const buggy = await explore(name, newHandler, true, false);
  if (buggy.findings.length === 0) {
    bad = true;
  }
  for (const s of [full, reduced]) {
    if (s.error !== undefined || s.findings.length > 0) {
      bad = true;
    }
  }
  const pick = (s: ExploreSummary) => ({ runs: s.runs, pruned: s.pruned ?? 0, complete: s.complete, seconds: Math.round(s.seconds * 100) / 100, findings: s.findings.length, error: s.error ?? null });
  results[name] = { full: pick(full), por: pick(reduced), buggyPorFoundAfterRuns: buggy.firstFindingAfterRuns ?? null };
  rows.push(
    `${name.padEnd(10)} full ${String(full.runs).padStart(5)} runs ${full.complete ? 'complete' : 'INCOMPLETE'} ${full.seconds.toFixed(1).padStart(6)} s | ` +
      `por ${String(reduced.runs).padStart(5)} runs (${reduced.pruned ?? 0} cut short) ${reduced.complete ? 'complete' : 'INCOMPLETE'} ${reduced.seconds.toFixed(1).padStart(6)} s` +
      ` | buggy with por: ${buggy.findings.length > 0 ? `found in run ${buggy.firstFindingAfterRuns}` : 'NOT FOUND'}` +
      `${full.findings.length + reduced.findings.length > 0 ? '  FIXED FOUND SOMETHING' : ''}`,
  );
  process.stderr.write(`${rows.at(-1)}\n`);
}
const dir = fileURLToPath(new URL('../.interleave/', import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(`${dir}por.json`, `${JSON.stringify(results, null, 2)}\n`);
console.log(rows.join('\n'));
process.exitCode = bad ? 1 : 0;

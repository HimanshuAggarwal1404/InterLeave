// Spike for the template-database reset idea (ROADMAP Phase 3): is cloning a
// database per run faster than today's reset (TRUNCATE + seed on the admin
// connection)? Measures, for the coupon seed:
//   - truncate: run seed.sql on a connection to the interleave database;
//   - clone: DROP + CREATE DATABASE ... TEMPLATE (both strategies, WAL_LOG and
//     FILE_COPY), plus opening one connection to the new database (the app
//     would have to reconnect after every clone).
// It only creates and drops its own databases, interleave_tpl_probe and
// interleave_run_probe. Usage: node scripts/measure-reset.ts [rounds]
// Writes .interleave/reset.json for docs/RESULTS.md.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROUNDS = Number(process.argv[2] ?? 20);
const BASE = 'postgres://interleave:interleave@127.0.0.1:5432';
const TEMPLATE = 'interleave_tpl_probe';
const RUN = 'interleave_run_probe';
const seed = await readFile(new URL('../victims/coupon/seed.sql', import.meta.url), 'utf8');

async function client(db: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: `${BASE}/${db}?sslmode=disable` });
  c.on('error', () => {});
  await c.connect();
  return c;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

async function timed(fn: () => Promise<void>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

const admin = await client('interleave');
const results: Record<string, unknown> = { when: new Date().toISOString(), rounds: ROUNDS };
try {
  // Today's reset, on the interleave database (the coupon tables).
  const truncate: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    truncate.push(await timed(async () => void (await admin.query(seed))));
  }
  results['truncate'] = { medianMs: median(truncate), minMs: Math.min(...truncate), maxMs: Math.max(...truncate) };

  // A template database with the same tables and rows.
  await admin.query(`DROP DATABASE IF EXISTS ${RUN}`);
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE}`);
  await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  const tpl = await client(TEMPLATE);
  await tpl.query(seed);
  await tpl.end(); // a template must have no connections while it is cloned

  for (const strategy of ['WAL_LOG', 'FILE_COPY']) {
    const clone: number[] = [];
    const withConnect: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t = performance.now();
      await admin.query(`DROP DATABASE IF EXISTS ${RUN}`);
      await admin.query(`CREATE DATABASE ${RUN} TEMPLATE ${TEMPLATE} STRATEGY ${strategy}`);
      clone.push(performance.now() - t);
      const c = await client(RUN);
      await c.query('SELECT 1');
      withConnect.push(performance.now() - t);
      await c.end();
    }
    results[strategy] = {
      cloneMedianMs: median(clone),
      cloneMinMs: Math.min(...clone),
      cloneMaxMs: Math.max(...clone),
      withReconnectMedianMs: median(withConnect),
    };
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${RUN}`);
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE}`);
  await admin.end();
}

const dir = fileURLToPath(new URL('../.interleave/', import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(`${dir}reset.json`, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));

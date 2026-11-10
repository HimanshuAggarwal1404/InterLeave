// The interleave command as a user runs it: a separate process, its output
// and its exit code (0 clean, 1 found, 2 usage).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newHandler, newPool } from './app.ts';
import { openServer, testPool } from './testutil.ts';
import { onCleanup } from '../../src/testutil/cleanup.ts';

const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const SCENARIO = fileURLToPath(new URL('./scenario.yaml', import.meta.url));
const SEED = fileURLToPath(new URL('./seed.sql', import.meta.url));

// interleave runs the CLI in its own process, feeding stdin, and returns its
// exit code and output.
function interleave(args: string[], stdin = ''): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(stdin);
  });
}

// freePort finds a port nothing listens on, for the CLI's proxy.
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

// setup starts the coupon app with its database URL pointed at the port the
// CLI's proxy will use, and writes a copy of the scenario aimed at that app.
async function setup(t: TestContext, fixed: boolean): Promise<{ dir: string; scenario: string; listen: string } | undefined> {
  if (!(await testPool(t))) return undefined; // skips if Postgres is down
  const port = await freePort();
  const pool = newPool(`postgres://interleave:interleave@127.0.0.1:${port}/interleave?sslmode=disable`);
  onCleanup(t, () => pool.end());
  const app = await openServer(newHandler(pool, fixed));
  onCleanup(t, () => app.close());
  const dir = await mkdtemp(join(tmpdir(), 'interleave-cli-'));
  onCleanup(t, () => rm(dir, { recursive: true, force: true }));
  const yaml = (await readFile(SCENARIO, 'utf8'))
    .replace('http://127.0.0.1:8081', app.url)
    .replace(/reset: seed\.sql.*/, `reset: ${JSON.stringify(SEED)}`);
  const scenario = join(dir, 'scenario.yaml');
  await writeFile(scenario, yaml);
  return { dir, scenario, listen: `127.0.0.1:${port}` };
}

test('RunFindsAndReplayReproduces', async (t) => {
  const s = await setup(t, false);
  if (!s) return;
  const out = join(s.dir, 'out');
  const run = await interleave(['run', s.scenario, '--listen', s.listen, '--out', out]);
  assert.equal(run.code, 1, `run: want exit 1 (found)\n${run.out}\n${run.err}`);
  assert.match(run.out, /RACE FOUND/);
  const files = await readdir(out);
  assert.equal(files.length, 1, 'one schedule file');

  // --step with Enter presses piped in: pauses before each statement, then reproduces.
  const replay = await interleave(['replay', join(out, files[0]), '--step', '--listen', s.listen], '\n'.repeat(30));
  assert.equal(replay.code, 1, `replay: want exit 1 (reproduced)\n${replay.out}\n${replay.err}`);
  assert.match(replay.err, /next: \[A\] BEGIN/);
  assert.match(replay.out, /Reproduced/);
});

test('RunOnTheFixedAppIsClean', async (t) => {
  const s = await setup(t, true);
  if (!s) return;
  const run = await interleave(['run', s.scenario, '--listen', s.listen, '--out', join(s.dir, 'out')]);
  assert.equal(run.code, 0, `want exit 0 (clean)\n${run.out}\n${run.err}`);
  assert.match(run.out, /No violation\. Complete: all \d+ orders checked/);
});

test('UsageErrorsExit2', async () => {
  const missing = await interleave(['run', 'no/such/scenario.yaml']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /cannot read scenario/);
  const noArg = await interleave(['replay']);
  assert.equal(noArg.code, 2);
});

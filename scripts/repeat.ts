// Runs the pgwire, proxy and sched test suites N times in a row (default 20) and stops
// at the first failure. Node has no race detector, so repeating the concurrent
// tests many times is how we shake out timing-dependent bugs (see docs/TESTING.md).
//
// Usage: node scripts/repeat.ts [N] [extra test globs...]
import { spawnSync } from 'node:child_process';

const times = Number(process.argv[2] ?? '20');
if (!Number.isInteger(times) || times < 1) {
  console.error('usage: node scripts/repeat.ts [N >= 1] [test globs...]');
  process.exit(2);
}
const globs = process.argv.length > 3 ? process.argv.slice(3) : ['src/pgwire/*.test.ts', 'src/proxy/*.test.ts', 'src/sched/*.test.ts'];

const started = performance.now();
for (let i = 1; i <= times; i++) {
  // process.execPath is the node binary running this script; no shell is
  // involved, so the globs reach node --test unexpanded on every platform.
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=60000', '--test-reporter=dot', ...globs], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) {
    process.stdout.write(r.stdout);
    console.error(`run ${i}/${times}: FAILED (exit ${r.status})`);
    process.exit(1);
  }
  console.log(`run ${i}/${times}: ok`);
}
console.log(`all ${times} runs passed in ${((performance.now() - started) / 1000).toFixed(1)}s`);

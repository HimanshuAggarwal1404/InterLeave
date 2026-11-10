import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSummary, formatTimeline, readSchedule, stepSummary, stripTag, toScheduleFile, writeSchedule } from './index.ts';
import type { ExploreSummary, RunResult } from '../runner/types.ts';

const requests = [
  { tag: 'A', method: 'POST', path: '/redeem', body: { user_id: 1 } },
  { tag: 'B', method: 'POST', path: '/redeem', body: { user_id: 2 } },
];

// The coupon double-redeem, as a run result.
const raceRun: RunResult = {
  index: 7,
  outcome: 'complete',
  trace: {
    outcome: 'complete',
    steps: [
      { tag: 'A', sql: '/* il:req=A */ BEGIN', status: 'T', result: { command: 'BEGIN' }, blocked: false },
      { tag: 'A', sql: "/* il:req=A */ SELECT uses, max_uses FROM coupons WHERE code = 'DIWALI50'", status: 'T', result: { command: 'SELECT 1', firstValue: '0' }, blocked: false },
      { tag: 'B', sql: '/* il:req=B */ BEGIN', status: 'T', result: { command: 'BEGIN' }, blocked: false },
      { tag: 'B', sql: "/* il:req=B */ SELECT uses, max_uses FROM coupons WHERE code = 'DIWALI50'", status: 'T', result: { command: 'SELECT 1', firstValue: '0' }, blocked: false },
      { tag: 'A', sql: "/* il:req=A */ UPDATE coupons SET uses = uses + 1 WHERE code = 'DIWALI50'", status: 'T', result: { command: 'UPDATE 1' }, blocked: false },
    ],
    decisions: [
      { runnable: ['A', 'B'], chosen: 'A' },
      { runnable: ['A', 'B'], chosen: 'A' },
      { runnable: ['B'], chosen: 'B' },
      { runnable: ['A', 'B'], chosen: 'B' },
      { runnable: ['A', 'B'], chosen: 'A' },
    ],
  },
  responses: [
    { tag: 'A', status: 200, body: 'redeemed\n' },
    { tag: 'B', status: 200, body: 'redeemed\n' },
  ],
  invariants: [{ name: 'coupon not over-redeemed', ok: false, value: 'false' }],
  findings: ['invariant'],
  resetMs: 3,
  ms: 40,
};

test('StripTag', () => {
  assert.equal(stripTag('/* il:req=A */  SELECT 1\n  FROM t'), 'SELECT 1 FROM t');
  assert.equal(stripTag('SELECT 1'), 'SELECT 1');
});

test('StepSummary', () => {
  assert.equal(stepSummary({ tag: 'A', sql: 'x', status: 'T', result: { command: 'SELECT 1', firstValue: '0' }, blocked: false }), '→ 0');
  assert.equal(stepSummary({ tag: 'A', sql: 'x', status: 'T', result: { command: 'UPDATE 1' }, blocked: false }), '→ UPDATE 1');
  assert.equal(stepSummary({ tag: 'A', sql: 'x', status: 'T', result: { command: 'BEGIN' }, blocked: false }), '');
  assert.equal(stepSummary({ tag: 'A', sql: 'x', status: 'E', result: { error: { code: '40P01', message: 'deadlock detected' } }, blocked: true }), '✗ 40P01 deadlock detected (waited for a lock)');
  assert.equal(stepSummary({ tag: 'A', sql: 'x', blocked: false }), '(no reply)');
});

test('TimelineShowsOneColumnPerRequest', () => {
  const lines = formatTimeline(raceRun, requests, 100).split('\n');
  assert.match(lines[0], /^Request A: POST \/redeem \{"user_id":1\}\s+Request B: POST \/redeem/);
  assert.equal(lines[1], 'BEGIN', 'A in the first column');
  assert.match(lines[2], /^SELECT uses, max_uses FROM coupons .*→ 0$/);
  assert.match(lines[3], /^ {50}BEGIN$/, 'B in the second column');
  assert.match(lines[4], /^ {50}SELECT uses, max_uses .*→ 0$/);
  assert.match(lines[5], /^UPDATE coupons .*→ UPDATE 1$/);
  const tail = lines.slice(6).join('\n');
  assert.match(tail, /Request A → HTTP 200 redeemed/);
  assert.match(tail, /✗ coupon not over-redeemed \(got false\)/);
});

const summary: ExploreSummary = {
  scenarioName: 'coupon-double-redeem',
  scenarioFile: join(process.cwd(), 'victims', 'coupon', 'scenario.yaml'),
  strategy: 'exhaustive',
  seed: 1,
  maxRuns: 1000,
  runs: 7,
  complete: false,
  findings: [raceRun],
  interrupted: false,
  seconds: 0.5,
  resetSeconds: 0.02,
  firstFindingAfterRuns: 7,
  firstFindingAfterSeconds: 0.5,
};

test('Summary', () => {
  assert.match(formatSummary(summary), /^RACE FOUND: 1 finding in 7 runs\.\n7 runs in 0\.50s \(14\.0 runs\/s, resets 350\.0\/s\); first finding after 7 runs/);
  assert.match(formatSummary({ ...summary, findings: [], complete: true, firstFindingAfterRuns: undefined }), /No violation\. Complete: all 7 orders checked/);
  assert.match(formatSummary({ ...summary, findings: [], complete: false, firstFindingAfterRuns: undefined }), /stopped at --max-runs 1000/);
  assert.match(formatSummary({ ...summary, findings: [], strategy: 'random', firstFindingAfterRuns: undefined }), /random orders \(seed 1\)/);
});

test('ScheduleFileRoundTrip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'interleave-report-'));
  try {
    const file = toScheduleFile(summary, raceRun);
    assert.equal(file.scenario, 'victims/coupon/scenario.yaml', 'scenario path relative to the working folder');
    assert.deepEqual(file.choices, ['A', 'A', 'B', 'B', 'A']);
    const path = await writeSchedule(dir, file);
    assert.match(path, /coupon-double-redeem-7\.json$/);
    assert.deepEqual(await readSchedule(path), file);
    await assert.rejects(readSchedule(join(dir, 'missing.json')), /cannot read schedule/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

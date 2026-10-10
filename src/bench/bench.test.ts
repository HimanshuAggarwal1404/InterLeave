import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { formatDuration, median, newAgent, parseDuration, percentile, roundOrder, runRound, type Config } from './bench.ts';

// fakeApp answers every request with status and counts the requests it served.
async function fakeApp(t: TestContext, status: number): Promise<{ url: string; served: () => number }> {
  let served = 0;
  const server = http.createServer((_req, res) => {
    served++;
    res.writeHead(status).end(status >= 500 ? 'internal error\n' : 'coupon already used up\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/redeem`, served: () => served };
}

function config(url: string, workers: number): Config {
  return { url, code: 'DIWALI50', workers, warmupMs: 0, durationMs: 0, rounds: 1 };
}

// A round counts each request it sends exactly once, by status code, and 409
// (coupon used up) is not an error.
test('RunRoundCountsEveryResponse', async (t) => {
  const app = await fakeApp(t, 409);
  const agent = newAgent(4);
  t.after(() => agent.destroy());
  const res = await runRound(agent, config(app.url, 4), 100);

  assert.ok(res.requests > 0, 'round sent no requests');
  assert.equal(res.requests, app.served(), 'counted requests differ from what the server saw');
  assert.equal(res.statuses.get(409), res.requests, 'want every request counted as 409');
  assert.equal(res.errors, 0, `errors (first: ${res.firstErr})`);
  assert.equal(res.latencies.length, res.requests);
});

// Server errors are reported, so a broken setup cannot produce a good-looking req/s number.
test('RunRoundCounts5xxAsErrors', async (t) => {
  const app = await fakeApp(t, 500);
  const agent = newAgent(2);
  t.after(() => agent.destroy());
  const res = await runRound(agent, config(app.url, 2), 50);
  assert.ok(res.errors > 0 && res.errors === res.requests, `errors = ${res.errors}, requests = ${res.requests}; want every request to be an error`);
});

test('Percentile', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // milliseconds
  const cases: Array<[p: number, want: number]> = [
    [0.5, 5],
    [0.9, 9],
    [0.99, 10],
    [1.0, 10],
  ];
  for (const [p, want] of cases) {
    assert.equal(percentile(sorted, p), want, `percentile(${p})`);
  }
  assert.equal(percentile([], 0.5), 0, 'percentile of empty');
});

// Rounds alternate A B, B A, A B, ... so that a laptop slowing down as it
// heats up does not always favour the target that goes first.
test('RoundOrder', () => {
  const cases: Array<[round: number, targets: number, want: number[]]> = [
    [1, 1, [0]],
    [2, 1, [0]],
    [1, 2, [0, 1]],
    [2, 2, [1, 0]],
    [3, 2, [0, 1]],
    [4, 3, [2, 1, 0]],
  ];
  for (const [round, targets, want] of cases) {
    assert.deepEqual(roundOrder(round, targets), want, `roundOrder(${round}, ${targets})`);
  }
});

test('Median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
});

// The flags take Go-style durations, as the Go version of the bench did.
test('ParseDuration', () => {
  const cases: Array<[text: string, wantMs: number]> = [
    ['3s', 3000],
    ['100ms', 100],
    ['1m30s', 90000],
    ['2.5s', 2500],
    ['0', 0],
    ['250us', 0.25],
  ];
  for (const [text, want] of cases) {
    assert.equal(parseDuration(text), want, text);
  }
  for (const bad of ['', '10', 's', '1x', '1s2']) {
    assert.throws(() => parseDuration(bad), Error, `parseDuration(${JSON.stringify(bad)}) should fail`);
  }
});

// Latencies print like Go's Duration.String after rounding to the microsecond.
test('FormatDuration', () => {
  const cases: Array<[ms: number, want: string]> = [
    [0.5773, '577µs'],
    [1.2594, '1.259ms'],
    [1.2, '1.2ms'],
    [10000, '10s'],
    [90000, '1m30s'],
    [0, '0s'],
  ];
  for (const [ms, want] of cases) {
    assert.equal(formatDuration(ms), want, `formatDuration(${ms})`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { fireRequests } from './harness.ts';
import { onCleanup } from '../testutil/cleanup.ts';

test('FiresTaggedRequestsTogether', async (t) => {
  const seen: Array<{ tag: string | undefined; method: string | undefined; url: string | undefined; body: string }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ tag: req.headers['x-interleave-req'] as string | undefined, method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
      // Answer only once both requests have arrived: proves they were in flight together.
      setTimeout(() => {
        inFlight--;
        res.writeHead(req.headers['x-interleave-req'] === 'A' ? 200 : 409).end(`hello ${req.headers['x-interleave-req']}`);
      }, 50);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  onCleanup(t, () => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

  const finished: string[] = [];
  const responses = await fireRequests(
    base,
    [
      { tag: 'A', method: 'POST', path: '/redeem', body: { code: 'X', user_id: 1 } },
      { tag: 'B', method: 'POST', path: '/redeem', body: { code: 'X', user_id: 2 } },
    ],
    { finished: (tag) => finished.push(tag) },
  );
  assert.deepEqual(
    responses.map((r) => `${r.tag} ${r.status} ${r.body}`),
    ['A 200 hello A', 'B 409 hello B'],
  );
  assert.deepEqual([...finished].sort(), ['A', 'B'], 'finished is called once per request');
  assert.equal(maxInFlight, 2, 'both requests must be in flight at the same time');
  assert.deepEqual(
    seen.map((s) => `${s.tag} ${s.method} ${s.url} ${s.body}`).sort(),
    ['A POST /redeem {"code":"X","user_id":1}', 'B POST /redeem {"code":"X","user_id":2}'],
  );
});

test('ScenarioHeadersDoNotDuplicate', async (t) => {
  // Header names are case-insensitive: a scenario's "content-type" replaces
  // the default Content-Type, and the tag header always comes from the
  // harness, whatever case the scenario wrote it in.
  let raw: string[] = [];
  const server = http.createServer((req, res) => {
    raw = req.rawHeaders;
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  onCleanup(t, () => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

  await fireRequests(base, [
    { tag: 'A', method: 'POST', path: '/', body: { x: 1 }, headers: { 'content-type': 'application/vnd.test+json', 'x-interleave-req': 'Z' } },
  ]);
  const values = (name: string) => raw.filter((_, i) => i % 2 === 1 && raw[i - 1].toLowerCase() === name);
  assert.deepEqual(values('content-type'), ['application/vnd.test+json']);
  assert.deepEqual(values('x-interleave-req'), ['A']);
});

test('ReportsAnUnreachableApp', async () => {
  const finished: string[] = [];
  // Port 9 (discard) on 127.0.0.1: nothing listens there.
  const [r] = await fireRequests('http://127.0.0.1:9', [{ tag: 'A', method: 'GET', path: '/' }], { finished: (tag) => finished.push(tag) });
  assert.equal(r.status, 0);
  assert.match(r.error ?? '', /ECONNREFUSED|connect/);
  assert.deepEqual(finished, ['A'], 'a failed request still counts as finished');
});

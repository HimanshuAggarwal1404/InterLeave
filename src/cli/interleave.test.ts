import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryLogLine, run } from './interleave.ts';

test('RunUsageErrors', async (t) => {
  const cases: Array<[name: string, args: string[]]> = [
    ['no command', []],
    ['unknown command', ['explode']],
    ['unknown flag', ['proxy', '--nope']],
    ['remote upstream refused', ['proxy', '--upstream', 'db.example.com:5432']],
    ['bad listen address', ['proxy', '--listen', 'not-an-address']],
  ];
  for (const [name, args] of cases) {
    await t.test(name, async () => {
      assert.equal(await run(args), 2, `run(${JSON.stringify(args)}), want 2 (usage or configuration error)`);
    });
  }
});

test('QueryLogLine', () => {
  const cases: Array<[tag: string, sql: string, want: string]> = [
    ['A', '/* il:req=A */ SELECT 1', 'query [A] /* il:req=A */ SELECT 1'],
    ['', 'begin', 'query [-] begin'],
    ['B', '/* il:req=B */ SELECT 1\n  FROM t', 'query [B] /* il:req=B */ SELECT 1 FROM t'],
  ];
  for (const [tag, sql, want] of cases) {
    assert.equal(queryLogLine(tag, sql), want);
  }
});

// The proxy command runs until it is told to stop (Ctrl+C in a terminal; the
// signal here), then shuts down cleanly and exits 0 without leaving its
// Ctrl+C handler behind.
test('ProxyCommandStopsOnAbort', async () => {
  const sigintListeners = process.listenerCount('SIGINT');
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 200);
  const code = await run(['proxy', '--listen', '127.0.0.1:0'], ctl.signal);
  assert.equal(code, 0);
  assert.equal(process.listenerCount('SIGINT'), sigintListeners, 'SIGINT listener left behind');
});

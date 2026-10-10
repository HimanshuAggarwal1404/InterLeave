import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryString, type Message } from './index.ts';
import { bytes } from '../testutil/bytes.ts';

// msg builds a Message with only type and body set, which is all queryString reads.
function msg(type: string, body: Buffer): Message {
  return { type, body, raw: body };
}

test('QueryString', async (t) => {
  const cases: Array<{ name: string; m: Message; want?: string; wantErr?: boolean }> = [
    // 'Q' body: the SQL text, then one NUL byte.
    { name: 'simple query', m: msg('Q', bytes('SELECT 1\x00')), want: 'SELECT 1' },
    { name: 'tagged query', m: msg('Q', bytes('/* il:req=A */ SELECT 1\x00')), want: '/* il:req=A */ SELECT 1' },
    // An empty query string is legal: Postgres answers EmptyQueryResponse.
    { name: 'empty query', m: msg('Q', bytes([0x00])), want: '' },
    { name: 'not a Query', m: msg('X', bytes()), wantErr: true },
    { name: 'missing NUL', m: msg('Q', bytes('SELECT 1')), wantErr: true },
    { name: 'empty body', m: msg('Q', bytes()), wantErr: true },
    { name: 'bytes after NUL', m: msg('Q', bytes('SELECT 1\x00x\x00')), wantErr: true },
  ];
  for (const tt of cases) {
    await t.test(tt.name, () => {
      if (tt.wantErr) {
        assert.throws(() => queryString(tt.m));
      } else {
        assert.equal(queryString(tt.m), tt.want);
      }
    });
  }
});

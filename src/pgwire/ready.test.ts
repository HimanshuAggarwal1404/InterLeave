import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyStatus, type Message, type ReadyStatus } from './index.ts';
import { bytes } from '../testutil/bytes.ts';

function msg(type: string, body: Buffer): Message {
  return { type, body, raw: body };
}

test('ReadyStatus', async (t) => {
  // 'Z' body: one status byte.
  const cases: Array<{ name: string; m: Message; want?: ReadyStatus; wantErr?: boolean }> = [
    { name: 'idle', m: msg('Z', bytes('I')), want: 'I' },
    { name: 'in transaction', m: msg('Z', bytes('T')), want: 'T' },
    { name: 'failed transaction', m: msg('Z', bytes('E')), want: 'E' },
    { name: 'not ReadyForQuery', m: msg('C', bytes('I')), wantErr: true },
    { name: 'empty body', m: msg('Z', bytes()), wantErr: true },
    { name: 'two bytes', m: msg('Z', bytes('II')), wantErr: true },
    { name: 'unknown status', m: msg('Z', bytes('X')), wantErr: true },
  ];
  for (const tt of cases) {
    await t.test(tt.name, () => {
      if (tt.wantErr) {
        assert.throws(() => readyStatus(tt.m));
      } else {
        assert.equal(readyStatus(tt.m), tt.want);
      }
    });
  }
});

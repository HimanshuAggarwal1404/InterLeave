import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TagError, requestTag } from './tag.ts';

test('RequestTag', async (t) => {
  const cases: Array<{ name: string; sql: string; want?: string; wantErr?: boolean }> = [
    { name: 'tagged', sql: '/* il:req=A */ SELECT 1', want: 'A' },
    { name: 'leading whitespace', sql: ' \n\t/* il:req=B */ SELECT 1', want: 'B' },
    { name: 'no spaces inside comment', sql: '/*il:req=A*/SELECT 1', want: 'A' },
    { name: 'longer tag', sql: '/* il:req=req_2-b */ BEGIN', want: 'req_2-b' },
    { name: 'tag only', sql: '/* il:req=A */', want: 'A' },
    { name: '64 characters', sql: '/* il:req=' + 'a'.repeat(64) + ' */ SELECT 1', want: 'a'.repeat(64) },

    { name: 'untagged', sql: 'SELECT 1', want: '' },
    { name: 'empty', sql: '', want: '' },
    { name: 'other comment', sql: '/* healthcheck */ SELECT 1', want: '' },
    { name: 'line comment', sql: '-- il:req=A\nSELECT 1', want: '' },
    // Only the start counts (D-015), so text inside a value cannot pose as a tag.
    { name: 'tag later in query', sql: "SELECT '/* il:req=A */'", want: '' },
    { name: 'tag after statement', sql: 'SELECT 1 /* il:req=A */', want: '' },

    // Looks like our tag but is broken: an app bug worth reporting.
    { name: 'empty tag', sql: '/* il:req= */ SELECT 1', wantErr: true },
    { name: 'unterminated', sql: '/* il:req=A SELECT 1', wantErr: true },
    { name: 'bad character', sql: '/* il:req=A;B */ SELECT 1', wantErr: true },
    { name: 'space inside tag', sql: '/* il:req=A B */ SELECT 1', wantErr: true },
    { name: 'too long', sql: '/* il:req=' + 'a'.repeat(65) + ' */', wantErr: true },
  ];
  for (const tt of cases) {
    await t.test(tt.name, () => {
      if (tt.wantErr) {
        assert.throws(() => requestTag(tt.sql), TagError);
      } else {
        assert.equal(requestTag(tt.sql), tt.want);
      }
    });
  }
});

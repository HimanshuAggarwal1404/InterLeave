import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { lineReader } from './lines.ts';

// Piped input arrives all at once, before anyone asks for a line: every line
// must still be handed out one per call, in order.
test('LinesThatArrivedEarlyAreQueued', async () => {
  const input = new PassThrough();
  input.end('first\nsecond\n');
  const lines = lineReader(input);
  try {
    assert.equal(await lines.next(), 'first');
    assert.equal(await lines.next(), 'second');
    // After the end of input, next() resolves with undefined instead of waiting forever.
    assert.equal(await lines.next(), undefined);
  } finally {
    lines.close();
  }
});

// Typed input arrives later: next() waits for it.
test('NextWaitsForALine', async () => {
  const input = new PassThrough();
  const lines = lineReader(input);
  try {
    const pending = lines.next();
    setTimeout(() => input.write('typed\n'), 20);
    assert.equal(await pending, 'typed');
  } finally {
    lines.close();
    input.end();
  }
});

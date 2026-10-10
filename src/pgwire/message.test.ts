import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ProtocolError, UnexpectedEOFError, WireReader } from './index.ts';
import { bytes, chunksOf, hex } from '../testutil/bytes.ts';

const readMessageCases: Array<{ name: string; input: Buffer; wantType: string; wantBody: Buffer }> = [
  {
    // Captured from Postgres 18.6 after psql's StartupMessage:
    // 'R' AuthenticationSASL, len 23, code 10, mechanism "SCRAM-SHA-256", list end.
    name: 'AuthenticationSASL (captured)',
    input: bytes(
      ['R'.charCodeAt(0), 0x00, 0x00, 0x00, 0x17],
      [0x00, 0x00, 0x00, 0x0a],
      'SCRAM-SHA-256\x00',
      [0x00],
    ),
    wantType: 'R',
    wantBody: bytes('\x00\x00\x00\x0aSCRAM-SHA-256\x00\x00'),
  },
  {
    // 'Z' ReadyForQuery, len 5, status 'I' (idle, not in a transaction).
    name: 'ReadyForQuery idle',
    input: bytes('Z', [0x00, 0x00, 0x00, 0x05], 'I'),
    wantType: 'Z',
    wantBody: bytes('I'),
  },
  {
    // 'Q' Query "SELECT 1", len 4 + 9 = 13 (the SQL ends with a NUL byte).
    name: 'Query',
    input: bytes('Q', [0x00, 0x00, 0x00, 0x0d], 'SELECT 1\x00'),
    wantType: 'Q',
    wantBody: bytes('SELECT 1\x00'),
  },
  {
    // 'X' Terminate, len 4: the length counts only itself, so the body is empty.
    name: 'Terminate (empty body)',
    input: bytes('X', [0x00, 0x00, 0x00, 0x04]),
    wantType: 'X',
    wantBody: bytes(),
  },
  {
    // 'K' BackendKeyData, protocol 3.0: len 12, PID 4242, 4-byte secret key.
    name: 'BackendKeyData protocol 3.0',
    input: bytes('K', [0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef]),
    wantType: 'K',
    wantBody: bytes([0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef]),
  },
  {
    // 'K' BackendKeyData, protocol 3.2: len 8 + 32, PID 4242, 32-byte secret key.
    // Same message type, different size: why we never assume fixed sizes.
    name: 'BackendKeyData protocol 3.2 (long key)',
    input: bytes('K', [0x00, 0x00, 0x00, 0x28, 0x00, 0x00, 0x10, 0x92], Buffer.alloc(32, 0xab)),
    wantType: 'K',
    wantBody: bytes([0x00, 0x00, 0x10, 0x92], Buffer.alloc(32, 0xab)),
  },
];

test('ReadMessage', async (t) => {
  for (const tt of readMessageCases) {
    // Whole, and one byte per chunk: framing must not depend on how the bytes arrive.
    for (const [label, size] of [['in one chunk', tt.input.length], ['one byte per chunk', 1]] as const) {
      await t.test(`${tt.name}, ${label}`, async () => {
        const m = await new WireReader(chunksOf(tt.input, size)).readMessage();
        assert.ok(m, 'readMessage returned null, want a message');
        assert.equal(m.type, tt.wantType);
        assert.equal(hex(m.body), hex(tt.wantBody));
        // raw must be exactly the bytes we read, so the proxy can forward them unchanged.
        assert.equal(hex(m.raw), hex(tt.input));
      });
    }
  }
});

// TCP has no message boundaries: two messages arrive as one stream of bytes.
// Reading twice must split them exactly where the length field says.
test('ReadMessageBackToBack', async () => {
  const stream = bytes(
    'C', [0x00, 0x00, 0x00, 0x0d], 'UPDATE 1\x00', // CommandComplete "UPDATE 1"
    'Z', [0x00, 0x00, 0x00, 0x05], 'T', // ReadyForQuery, in a transaction
  );
  const r = new WireReader(chunksOf(stream));

  const first = await r.readMessage();
  assert.equal(first?.type, 'C');
  assert.equal(first?.body.toString('latin1'), 'UPDATE 1\x00');

  const second = await r.readMessage();
  assert.equal(second?.type, 'Z');
  assert.equal(second?.body.toString('latin1'), 'T');

  assert.equal(await r.readMessage(), null, 'after the last message, want null (clean end of stream)');
});

test('ReadMessageErrors', async (t) => {
  const cases: Array<{ name: string; input: Buffer; want: typeof ProtocolError | typeof UnexpectedEOFError | null }> = [
    // Nothing at all: the other side closed the connection cleanly between messages.
    { name: 'clean EOF', input: bytes(), want: null },
    // Cut off inside the 5-byte header or inside the body: the connection died mid-message.
    { name: 'truncated header', input: bytes('Z', [0x00, 0x00]), want: UnexpectedEOFError },
    { name: 'truncated body', input: bytes('Q', [0x00, 0x00, 0x00, 0x0d], 'SEL'), want: UnexpectedEOFError },
    // The length includes its own 4 bytes, so anything below 4 is corrupt.
    { name: 'length below 4', input: bytes('Z', [0x00, 0x00, 0x00, 0x03]), want: ProtocolError },
    // 0x7fffffff (about 2 GB): must be rejected before buffering any of it.
    { name: 'absurd length', input: bytes('D', [0x7f, 0xff, 0xff, 0xff]), want: ProtocolError },
  ];
  for (const tt of cases) {
    await t.test(tt.name, async () => {
      const read = new WireReader(chunksOf(tt.input)).readMessage();
      if (tt.want === null) {
        assert.equal(await read, null);
      } else {
        await assert.rejects(read, tt.want);
      }
    });
  }
});

// An absurd length is refused as soon as the header is in, without waiting
// for a body that would never fit: the stream here stays open.
test('ReadMessageRejectsAbsurdLengthWithoutWaiting', { timeout: 5000 }, async () => {
  const src = new PassThrough();
  src.write(bytes('D', [0x7f, 0xff, 0xff, 0xff]));
  try {
    await assert.rejects(new WireReader(src).readMessage(), ProtocolError);
  } finally {
    src.destroy();
  }
});

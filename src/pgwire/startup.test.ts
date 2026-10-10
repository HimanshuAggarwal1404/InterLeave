import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCEL_REQUEST_CODE,
  GSSENC_REQUEST_CODE,
  PROTOCOL_VERSION_30,
  PROTOCOL_VERSION_32,
  ProtocolError,
  SSL_REQUEST_CODE,
  UnexpectedEOFError,
  WireReader,
} from './index.ts';
import { bytes, chunksOf, hex } from '../testutil/bytes.ts';

// Captured from psql 18.6 connecting with sslmode=prefer: first an SSLRequest,
// then (after the server answers 'N') this StartupMessage.

// len 8, code 80877103 = 1234<<16 | 5679.
const capturedSSLRequest = bytes([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);

// len 67, code 196608 = 3<<16 | 0 (protocol 3.0), then name/value pairs,
// each NUL-terminated, and one final NUL that ends the list.
const capturedStartup = bytes(
  '\x00\x00\x00\x43\x00\x03\x00\x00' +
    'user\x00interleave\x00' +
    'database\x00interleave\x00' +
    'application_name\x00psql\x00' +
    '\x00',
);

test('ReadStartup', async (t) => {
  const cases: Array<{ name: string; input: Buffer; wantCode: number; wantParams?: Record<string, string> }> = [
    { name: 'SSLRequest (captured)', input: capturedSSLRequest, wantCode: SSL_REQUEST_CODE },
    {
      name: 'StartupMessage protocol 3.0 (captured)',
      input: capturedStartup,
      wantCode: PROTOCOL_VERSION_30,
      wantParams: { user: 'interleave', database: 'interleave', application_name: 'psql' },
    },
    {
      // Same as the captured packet but asking for protocol 3.2 (code 196610).
      // Postgres 18 accepts it; we must too, and let the server negotiate.
      name: 'StartupMessage protocol 3.2',
      input: bytes('\x00\x00\x00\x2d\x00\x03\x00\x02' + 'user\x00interleave\x00database\x00interleave\x00\x00'),
      wantCode: PROTOCOL_VERSION_32,
      wantParams: { user: 'interleave', database: 'interleave' },
    },
    {
      // len 8, code 80877104 = 1234<<16 | 5680.
      name: 'GSSENCRequest',
      input: bytes([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x30]),
      wantCode: GSSENC_REQUEST_CODE,
    },
    {
      // len 16, code 80877102 = 1234<<16 | 5678, PID 4242, 4-byte secret key.
      name: 'CancelRequest',
      input: bytes([0x00, 0x00, 0x00, 0x10, 0x04, 0xd2, 0x16, 0x2e, 0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef]),
      wantCode: CANCEL_REQUEST_CODE,
    },
  ];
  for (const tt of cases) {
    for (const [label, size] of [['in one chunk', tt.input.length], ['one byte per chunk', 1]] as const) {
      await t.test(`${tt.name}, ${label}`, async () => {
        const s = await new WireReader(chunksOf(tt.input, size)).readStartup();
        assert.ok(s, 'readStartup returned null, want a packet');
        assert.equal(s.code, tt.wantCode);
        assert.deepEqual(s.params, tt.wantParams === undefined ? undefined : new Map(Object.entries(tt.wantParams)));
        assert.equal(hex(s.raw), hex(tt.input));
      });
    }
  }
});

// psql sends SSLRequest and, after our 'N', the StartupMessage on the same
// connection. Two reads must return them in order.
test('ReadStartupSSLThenStartup', async () => {
  const r = new WireReader(chunksOf(bytes(capturedSSLRequest, capturedStartup)));
  const first = await r.readStartup();
  assert.equal(first?.code, SSL_REQUEST_CODE);
  const second = await r.readStartup();
  assert.equal(second?.code, PROTOCOL_VERSION_30);
  assert.equal(second?.params?.get('database'), 'interleave');
});

test('ReadStartupErrors', async (t) => {
  const cases: Array<{ name: string; input: Buffer; want: typeof ProtocolError | typeof UnexpectedEOFError | null }> = [
    { name: 'clean EOF', input: bytes(), want: null },
    { name: 'truncated length', input: bytes([0x00, 0x00]), want: UnexpectedEOFError },
    { name: 'truncated body', input: bytes([0x00, 0x00, 0x00, 0x43, 0x00, 0x03]), want: UnexpectedEOFError },
    // Every startup packet has at least length + code = 8 bytes.
    { name: 'length below 8', input: bytes([0x00, 0x00, 0x00, 0x07, 0x00, 0x03, 0x00]), want: ProtocolError },
    // Postgres refuses startup packets over 10000 bytes; so do we, before buffering it.
    { name: 'absurd length', input: bytes([0x00, 0x01, 0x00, 0x00]), want: ProtocolError },
    // Parameter list missing its final NUL.
    { name: 'params not terminated', input: bytes('\x00\x00\x00\x18\x00\x03\x00\x00user\x00interleave\x00'), want: ProtocolError },
  ];
  for (const tt of cases) {
    await t.test(tt.name, async () => {
      const read = new WireReader(chunksOf(tt.input)).readStartup();
      if (tt.want === null) {
        assert.equal(await read, null);
      } else {
        await assert.rejects(read, tt.want);
      }
    });
  }
});

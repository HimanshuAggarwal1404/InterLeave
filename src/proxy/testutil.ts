// Test helpers for the proxy tests. Not a test file itself.
import net from 'node:net';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { PgProxy } from './proxy.ts';
import { bytes, hex } from '../testutil/bytes.ts';
import { onCleanup } from '../testutil/cleanup.ts';

const TIMEOUT_MS = 5000;

// Byte fixtures. Same encodings as the pgwire tests (see there for captures).
export const sslRequest = bytes([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
// StartupMessage, protocol 3.0: user=interleave database=interleave.
export const startupMsg = bytes('\x00\x00\x00\x2d\x00\x03\x00\x00' + 'user\x00interleave\x00database\x00interleave\x00\x00');
// CancelRequest for PID 4242 with a 4-byte secret key.
export const cancelRequest = bytes([0x00, 0x00, 0x00, 0x10, 0x04, 0xd2, 0x16, 0x2e, 0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef]);
// 'R' AuthenticationOk (len 8, code 0), then 'Z' ReadyForQuery idle.
export const authOKReady = bytes('R', [0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00], 'Z', [0x00, 0x00, 0x00, 0x05], 'I');
// 'Q' Query "SELECT 1".
export const query = bytes('Q', [0x00, 0x00, 0x00, 0x0d], 'SELECT 1\x00');
// 'X' Terminate.
export const terminate = bytes('X', [0x00, 0x00, 0x00, 0x04]);
// 'C' CommandComplete "SELECT 1".
export const commandComplete = bytes('C', [0x00, 0x00, 0x00, 0x0d], 'SELECT 1\x00');
// 'Z' ReadyForQuery, idle / inside a transaction block.
export const readyIdle = bytes('Z', [0x00, 0x00, 0x00, 0x05], 'I');
export const readyInTx = bytes('Z', [0x00, 0x00, 0x00, 0x05], 'T');

// queryMsg builds a 'Q' Query message: type, length (4 + text + NUL), text, NUL.
export function queryMsg(sql: string): Buffer {
  const text = Buffer.from(sql + '\x00', 'utf8');
  const header = Buffer.alloc(5);
  header.write('Q', 0, 'latin1');
  header.writeUInt32BE(4 + text.length, 1);
  return Buffer.concat([header, text]);
}

// withTimeout resolves like p, or fails with message after ms.
export async function withTimeout<T>(p: Promise<T>, message: string, ms = TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer); // never leave a timer behind: it would keep the test process alive
  }
}

// waitUntil polls cond once per event-loop turn until it is true, and fails
// after ms. It stops polling when it fails: a poll loop that outlived its
// test would keep the process alive and hang the whole run.
export async function waitUntil(cond: () => boolean, what: string, ms = TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting: ${what}`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

// TestConn is one end of a TCP connection that a test drives byte by byte.
// Every wait gives up after 5 s, so a misbehaving proxy fails the test
// instead of hanging it.
export class TestConn {
  readonly socket: net.Socket;
  #buf = Buffer.alloc(0);
  #ended = false; // closed by the other side, reset, or destroyed
  #wake: (() => void) | undefined;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (d: Buffer) => {
      this.#buf = Buffer.concat([this.#buf, d]);
      this.#wake?.();
    });
    const end = () => {
      this.#ended = true;
      this.#wake?.();
    };
    socket.on('end', end);
    socket.on('close', end);
    socket.on('error', end); // e.g. "connection reset" on Windows: also means the other side closed
  }

  write(b: Buffer): void {
    this.socket.write(b);
  }

  // expectBytes reads exactly want.length bytes and checks they equal want.
  async expectBytes(want: Buffer): Promise<void> {
    await this.#waitFor(() => this.#buf.length >= want.length || this.#ended, `reading ${want.length} bytes`);
    assert.ok(this.#buf.length >= want.length, `connection closed after ${this.#buf.length} of ${want.length} bytes: ${hex(this.#buf)}`);
    const got = this.#buf.subarray(0, want.length);
    this.#buf = this.#buf.subarray(want.length);
    assert.equal(hex(got), hex(want));
  }

  // expectEOF checks that the other side closed the connection and sent nothing more.
  async expectEOF(): Promise<void> {
    await this.#waitFor(() => this.#buf.length > 0 || this.#ended, 'connection still open after 5s, want it closed');
    assert.equal(this.#buf.length, 0, `got unexpected bytes ${hex(this.#buf)}, want connection closed`);
  }

  // close destroys the socket and resolves once its handle is released.
  async close(): Promise<void> {
    this.socket.destroy();
    if (!this.socket.closed) {
      await new Promise((r) => this.socket.once('close', r));
    }
  }

  async #waitFor(ready: () => boolean, what: string): Promise<void> {
    if (ready()) {
      return;
    }
    await withTimeout(
      new Promise<void>((resolve) => {
        this.#wake = () => {
          if (ready()) {
            this.#wake = undefined;
            resolve();
          }
        };
      }),
      `timed out ${what}`,
    );
  }
}

// listen starts server on a random free port of 127.0.0.1 and returns "127.0.0.1:port".
export async function listen(server: net.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const a = server.address() as net.AddressInfo;
  return `127.0.0.1:${a.port}`;
}

// dial connects to addr and closes the connection when the test ends.
export async function dial(t: TestContext, addr: string): Promise<TestConn> {
  const [host, port] = addr.split(':');
  const socket = net.connect({ host, port: Number(port) });
  const c = new TestConn(socket);
  await withTimeout(new Promise((r) => socket.once('connect', r)), `dial ${addr}`);
  onCleanup(t, () => c.close());
  return c;
}

// fakeUpstream stands in for Postgres: it listens on a random local port and
// hands the first connection the proxy opens to the test.
export async function fakeUpstream(
  t: TestContext,
): Promise<{ addr: string; accepted: () => Promise<TestConn>; close: () => Promise<void> }> {
  const server = net.createServer();
  let conn: TestConn | undefined;
  const first = new Promise<TestConn>((resolve) => {
    server.once('connection', (s) => {
      conn = new TestConn(s);
      resolve(conn);
    });
  });
  const addr = await listen(server);
  // close closes the accepted connection and the listener; safe to call twice.
  const close = async () => {
    await conn?.close();
    if (server.listening) {
      await new Promise((r) => server.close(r));
    }
  };
  onCleanup(t, close);
  return { addr, accepted: () => withTimeout(first, 'proxy never connected upstream'), close };
}

// serveProxy runs p on a random local port and returns its address. At test
// end it shuts the proxy down and fails the test if serve() does not settle
// within 5 s, which would mean a stuck connection or a leaked socket.
export async function serveProxy(t: TestContext, p: PgProxy): Promise<string> {
  const server = net.createServer();
  const addr = await listen(server);
  const ctl = new AbortController();
  const served = p.serve(server, ctl.signal);
  onCleanup(t, async () => {
    ctl.abort();
    await withTimeout(served, 'serve did not settle within 5s of abort');
  });
  return addr;
}

// startProxy is serveProxy for a new proxy in front of upstream.
export async function startProxy(t: TestContext, upstream: string): Promise<string> {
  return serveProxy(t, new PgProxy(upstream));
}

// openHandles counts the TCP sockets, TCP servers and timers that keep the
// process alive. Comparing it before and after a test proves nothing leaked.
export function openHandles(): number {
  return process
    .getActiveResourcesInfo()
    .filter((r) => r === 'TCPSocketWrap' || r === 'TCPServerWrap' || r === 'Timeout').length;
}

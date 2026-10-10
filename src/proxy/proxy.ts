// The proxy sits between an app and Postgres and forwards the wire protocol.
// Every message is forwarded unchanged; an optional hook sees each simple
// Query (and may hold it) and hears when Postgres has finished it.
import net from 'node:net';
import { once } from 'node:events';
import {
  CANCEL_REQUEST_CODE,
  GSSENC_REQUEST_CODE,
  SSL_REQUEST_CODE,
  WireReader,
  queryString,
  readyStatus,
  type Message,
  type ReadyStatus,
  type Startup,
} from '../pgwire/index.ts';
import { errorMessage, log } from '../log.ts';
import { forward, type ForwardHooks } from './forward.ts';
import { requestTag } from './tag.ts';

// DoneFn is called once Postgres has finished a query, with the status byte
// of that query's ReadyForQuery.
export type DoneFn = (status: ReadyStatus) => void;

// OnQuery is the scheduler hook (D-017). See PgProxy.onQuery.
export type OnQuery = (
  signal: AbortSignal,
  tag: string,
  sql: string,
) => Promise<DoneFn | undefined> | DoneFn | undefined;

// PgProxy forwards client connections to one local Postgres server. (Not
// named Proxy: that is a built-in JavaScript class.)
export class PgProxy {
  readonly #host: string;
  readonly #port: number;

  // onQuery, if set, is called for every simple Query an app sends, before
  // the query is forwarded, with its request tag ("" if untagged, D-015) and
  // SQL text. Set it before serve().
  //
  // While the Promise it returns is pending, the query waits (it is parked):
  // the proxy reads nothing more from that app connection. signal aborts when
  // the connection is torn down or the proxy shuts down; a parked onQuery must
  // then settle, or serve() cannot finish.
  //
  // If it returns (or resolves to) a done function, the proxy calls it once
  // Postgres has finished that query, that is once its ReadyForQuery has been
  // written to the app, with the status ('I', 'T' or 'E'). done is not called
  // if the connection ends first. Return undefined to skip it.
  //
  // If onQuery throws while the connection is still open, the error is logged
  // and the query is forwarded unscheduled.
  onQuery: OnQuery | undefined;

  // The upstream ("host:port") must be this machine: Interleave only ever
  // talks to the local Postgres (D-012). Anything else throws.
  constructor(upstream: string) {
    const { host, port } = splitHostPort(upstream);
    if (!isLoopback(host)) {
      throw new Error(`upstream ${JSON.stringify(upstream)}: host must be localhost, 127.0.0.1 or ::1`);
    }
    this.#host = host;
    this.#port = port;
  }

  // serve handles the connections of an already listening server until signal
  // aborts (it resolves) or the server fails (it rejects). Before settling it
  // closes the server and every open connection and waits until all of them
  // are closed, so when serve() has settled nothing it started is still running.
  async serve(server: net.Server, signal: AbortSignal): Promise<void> {
    // stop is aborted on shutdown or when the server fails; every connection listens to it.
    const stop = new AbortController();
    const onAbort = () => stop.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    let failure: Error | undefined;
    const onError = (err: Error) => {
      failure = new Error(`accepting connection: ${err.message}`, { cause: err });
      stop.abort(err);
    };
    const handles = new Set<Promise<void>>();
    const onConnection = (client: net.Socket) => {
      if (stop.signal.aborted) {
        client.destroy(); // arrived while shutting down
        return;
      }
      const h = this.#handle(client, stop.signal).finally(() => handles.delete(h));
      handles.add(h);
    };
    server.on('connection', onConnection);
    server.on('error', onError);
    try {
      if (!stop.signal.aborted) {
        await once(stop.signal, 'abort');
      }
      // server.close() only stops accepting: it does NOT close connections
      // that are already open. Each connection closes its own sockets when
      // stop aborts; here we wait for all of them, then for the server.
      const serverClosed = server.listening ? once(server, 'close') : Promise.resolve();
      if (server.listening) {
        server.close();
      }
      while (handles.size > 0) {
        await Promise.allSettled([...handles]);
      }
      await serverClosed;
    } finally {
      signal.removeEventListener('abort', onAbort);
      server.off('connection', onConnection);
      server.off('error', onError);
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  // #handle runs one client connection: the startup phase, then two pumps.
  async #handle(client: net.Socket, stop: AbortSignal): Promise<void> {
    const addr = `${client.remoteAddress}:${client.remotePort}`;
    // Errors are reported through the reads and writes below. Without a
    // listener, an 'error' event (e.g. a connection reset) would crash the
    // whole process.
    client.on('error', ignore);
    let upstream: net.Socket | undefined;

    // conn is aborted when this connection ends for any reason. It un-parks a
    // query waiting in onQuery and stops a pump waiting for 'drain'.
    const conn = new AbortController();
    // On shutdown, close both sockets at once: that makes every pending read
    // fail, so both pumps stop.
    const onStop = () => {
      conn.abort(stop.reason);
      client.destroy();
      upstream?.destroy();
    };
    stop.addEventListener('abort', onStop, { once: true });
    if (stop.aborted) {
      onStop();
    }

    try {
      // One reader for the connection's whole life: bytes the app sent after
      // the startup packet are already in its buffer.
      const clientR = new WireReader(client);
      let first: Startup | null;
      try {
        first = await readStartup(client, clientR);
      } catch (err) {
        if (!conn.signal.aborted) {
          log(`proxy: ${addr}: startup: ${errorMessage(err)}`);
        }
        return;
      }
      if (first === null || conn.signal.aborted) {
        return;
      }

      upstream = net.connect({ host: this.#host, port: this.#port });
      upstream.on('error', ignore);
      try {
        await once(upstream, 'connect', { signal: conn.signal });
      } catch (err) {
        if (!conn.signal.aborted) {
          log(`proxy: ${addr}: connecting to Postgres: ${errorMessage(err)}`);
        }
        return;
      }
      if (first.code === CANCEL_REQUEST_CODE) {
        // A cancel is the only thing sent on its connection; Postgres hangs up after it.
        upstream.end(first.raw);
        return;
      }
      upstream.write(first.raw);

      // Two pumps, one per direction. Whichever stops first closes both
      // sockets, which makes the other one's pending read end too, and aborts
      // conn, which un-parks a query waiting in onQuery.
      const server = upstream;
      const closeBoth = () => {
        conn.abort();
        closeGracefully(client);
        closeGracefully(server);
      };
      const toServer: ForwardHooks = { signal: conn.signal };
      const toClient: ForwardHooks = { signal: conn.signal };
      const onQuery = this.onQuery;
      if (onQuery !== undefined) {
        // One done per forwarded Query, oldest first. Postgres answers a
        // connection's queries in order, one ReadyForQuery each, so the next
        // ReadyForQuery always belongs to the oldest entry. A plain array is
        // enough: JavaScript runs one piece of code at a time, so the two
        // pumps never touch it at the same moment.
        const pending: Array<DoneFn | undefined> = [];
        toServer.inspect = (m) => inspectQuery(onQuery, conn.signal, addr, m, pending);
        toClient.sentReady = (m) => reportReady(addr, m, pending);
      }
      const pump = async (where: string, src: WireReader, dst: net.Socket, hooks: ForwardHooks) => {
        try {
          await forward(src, dst, hooks);
        } catch (err) {
          // Once we are closing, failed reads and writes are expected (Go: net.ErrClosed).
          if (!conn.signal.aborted) {
            log(`proxy: ${addr}: ${where}: ${errorMessage(err)}`);
          }
        } finally {
          closeBoth();
        }
      };
      await Promise.all([
        pump('app→postgres', clientR, server, toServer),
        pump('postgres→app', new WireReader(server), client, toClient),
      ]);
    } finally {
      conn.abort();
      closeGracefully(client);
      if (upstream !== undefined) {
        closeGracefully(upstream);
      }
      // Resolve only once both sockets are really closed. onStop stays
      // registered until then, so a shutdown can still destroy them.
      await Promise.all([closed(client), upstream === undefined ? undefined : closed(upstream)]);
      stop.removeEventListener('abort', onStop);
    }
  }
}

// readStartup reads startup packets until one is not an encryption request.
// The proxy answers 'N' (no) to SSL and GSS encryption itself, so the client
// carries on in plain text and the proxy can read every message.
async function readStartup(client: net.Socket, r: WireReader): Promise<Startup | null> {
  for (;;) {
    const s = await r.readStartup();
    if (s === null || (s.code !== SSL_REQUEST_CODE && s.code !== GSSENC_REQUEST_CODE)) {
      return s;
    }
    client.write('N');
  }
}

// inspectQuery reports a Query message to onQuery and queues the done it
// returns. Anything wrong with the message is logged, not fatal: it is
// forwarded anyway and Postgres judges it.
async function inspectQuery(
  onQuery: OnQuery,
  signal: AbortSignal,
  addr: string,
  m: Message,
  pending: Array<DoneFn | undefined>,
): Promise<void> {
  if (m.type !== 'Q') {
    return;
  }
  let done: DoneFn | undefined;
  let sql: string | undefined;
  try {
    sql = queryString(m);
  } catch (err) {
    log(`proxy: ${addr}: ${errorMessage(err)}`);
  }
  if (sql !== undefined) {
    let tag = '';
    try {
      tag = requestTag(sql);
    } catch (err) {
      log(`proxy: ${addr}: ${errorMessage(err)} (treated as untagged)`);
    }
    try {
      done = await onQuery(signal, tag, sql);
    } catch (err) {
      if (signal.aborted) {
        throw err; // the connection is going away; forward stops here
      }
      log(`proxy: ${addr}: onQuery failed: ${errorMessage(err)} (query forwarded unscheduled)`);
    }
  }
  // Queue even an undefined done: this Query still gets a ReadyForQuery, and
  // skipping it would pair every later reply with the wrong query. This runs
  // before the Query is forwarded, so its reply cannot come back first.
  pending.push(done);
}

// reportReady hands a ReadyForQuery's status to the oldest queued done. If
// nothing is queued, the ReadyForQuery answers no Query of ours: it is the one
// that ends startup, or it ends an extended-protocol Sync (FR-6).
function reportReady(addr: string, m: Message, pending: Array<DoneFn | undefined>): void {
  let status: ReadyStatus;
  try {
    status = readyStatus(m);
  } catch (err) {
    log(`proxy: ${addr}: ${errorMessage(err)}`);
    return;
  }
  if (pending.length === 0) {
    return;
  }
  const done = pending.shift();
  if (done !== undefined) {
    try {
      done(status);
    } catch (err) {
      log(`proxy: ${addr}: done callback failed: ${errorMessage(err)}`);
    }
  }
}

// closeGracefully sends what is still queued for s, then closes it (like Go's
// Close: bytes already written are not thrown away).
function closeGracefully(s: net.Socket): void {
  if (!s.destroyed && !s.writableEnded) {
    s.end(() => s.destroy());
  }
}

// closed resolves once s has emitted 'close' (its handle is released).
function closed(s: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (s.closed) {
      resolve();
    } else {
      s.once('close', () => resolve());
    }
  });
}

function ignore(): void {}

// splitHostPort splits "host:port", "[::1]:port" or ":port" like Go's
// net.SplitHostPort, and checks that the port is a number from 0 to 65535.
export function splitHostPort(addr: string): { host: string; port: number } {
  let host: string;
  let portText: string;
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    if (end < 0 || addr[end + 1] !== ':') {
      throw new Error(`address ${JSON.stringify(addr)}: missing port or ']'`);
    }
    host = addr.slice(1, end);
    portText = addr.slice(end + 2);
  } else {
    const colon = addr.lastIndexOf(':');
    if (colon < 0) {
      throw new Error(`address ${JSON.stringify(addr)}: missing port`);
    }
    host = addr.slice(0, colon);
    portText = addr.slice(colon + 1);
    if (host.includes(':')) {
      throw new Error(`address ${JSON.stringify(addr)}: too many colons (write IPv6 as [::1]:port)`);
    }
  }
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) {
    throw new Error(`address ${JSON.stringify(addr)}: invalid port ${JSON.stringify(portText)}`);
  }
  return { host, port };
}

// loopback matches 127.0.0.0/8 and ::1, including the IPv4-mapped form
// ::ffff:127.x.x.x. net.BlockList is Node's built-in IP address matcher.
const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
loopback.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export function isLoopback(host: string): boolean {
  if (host === 'localhost') {
    return true;
  }
  if (net.isIPv4(host)) {
    return loopback.check(host, 'ipv4');
  }
  if (net.isIPv6(host)) {
    return loopback.check(host, 'ipv6');
  }
  return false;
}

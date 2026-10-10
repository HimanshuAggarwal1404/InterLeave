// The interleave command: finds race conditions in database-backed web apps.
import net from 'node:net';
import { parseArgs } from 'node:util';
import { PgProxy, splitHostPort } from '../proxy/index.ts';
import { errorMessage, log } from '../log.ts';

// Exit codes (docs/SPEC.md section 3).
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_INTERNAL = 3;

const usage = `usage:
  interleave proxy [--listen 127.0.0.1:6433] [--upstream 127.0.0.1:5432] [--verbose]
      pass-through proxy, for debugging (Ctrl+C to stop); --verbose logs
      every query with its request tag`;

// run executes one command and returns the process exit code. signal, if
// given, stops a long-running command the way Ctrl+C does (used by tests).
export async function run(args: string[], signal?: AbortSignal): Promise<number> {
  if (args.length === 0) {
    console.error(usage);
    return EXIT_USAGE;
  }
  switch (args[0]) {
    case 'proxy':
      return runProxy(args.slice(1), signal);
    default:
      console.error(`unknown command ${JSON.stringify(args[0])}\n${usage}`);
      return EXIT_USAGE;
  }
}

async function runProxy(args: string[], signal: AbortSignal | undefined): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        // 127.0.0.1, not "localhost": Node may resolve localhost to ::1 while
        // a server listens on 127.0.0.1 only, and not ":6433", which would
        // listen on every network interface (D-012).
        listen: { type: 'string', default: '127.0.0.1:6433' },
        upstream: { type: 'string', default: '127.0.0.1:5432' },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true, // unknown flags are errors
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${errorMessage(err)}\n${usage}`);
    return EXIT_USAGE;
  }
  if (values.help) {
    console.error(usage);
    return EXIT_OK;
  }

  let p: PgProxy;
  let listenAt: { host: string; port: number };
  try {
    p = new PgProxy(values.upstream);
    listenAt = splitHostPort(values.listen);
  } catch (err) {
    console.error(errorMessage(err));
    return EXIT_USAGE;
  }
  if (values.verbose) {
    p.onQuery = (_signal, tag, sql) => {
      log(queryLogLine(tag, sql));
      return undefined; // log only: never park, no done needed
    };
  }

  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenAt.port, listenAt.host === '' ? undefined : listenAt.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    console.error(`cannot listen on ${values.listen}: ${errorMessage(err)}`);
    return EXIT_USAGE;
  }

  // Ctrl+C (SIGINT) aborts stop, which makes serve close everything and return.
  // While our listener is registered, Node does not exit on Ctrl+C by itself.
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once('SIGINT', onStop);
  signal?.addEventListener('abort', onStop, { once: true });
  if (signal?.aborted) {
    onStop();
  }
  const a = server.address() as net.AddressInfo;
  log(`interleave proxy: ${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port} -> ${values.upstream} (Ctrl+C to stop)`);
  try {
    await p.serve(server, stop.signal);
  } catch (err) {
    log(`interleave proxy: ${errorMessage(err)}`);
    return EXIT_INTERNAL;
  } finally {
    process.off('SIGINT', onStop);
    signal?.removeEventListener('abort', onStop);
  }
  log('interleave proxy: stopped');
  return EXIT_OK;
}

// queryLogLine formats one query for --verbose: its tag ("-" if untagged)
// and its SQL on one line.
export function queryLogLine(tag: string, sql: string): string {
  return `query [${tag === '' ? '-' : tag}] ${sql.split(/\s+/).filter((w) => w !== '').join(' ')}`;
}

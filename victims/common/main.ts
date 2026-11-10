// startVictim is the shared entry point of the victim apps:
//   node victims/<name>/main.ts [--addr 127.0.0.1:<port>] [--dsn <postgres url>] [--fixed]
// The default DSN goes through Interleave's proxy (127.0.0.1:6433); use port
// 5432 to talk to Postgres directly. The app starts even if the database is
// not reachable yet: the pool connects on first use.
import http from 'node:http';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { newPool } from './kit.ts';

export const PROXY_DSN = 'postgres://interleave:interleave@127.0.0.1:6433/interleave?sslmode=disable';
export const DIRECT_DSN = 'postgres://interleave:interleave@127.0.0.1:5432/interleave?sslmode=disable';

export async function startVictim(
  name: string,
  defaultPort: number,
  newHandler: (pool: pg.Pool, fixed: boolean) => http.RequestListener,
): Promise<void> {
  const usage = `usage: node victims/${name}/main.ts [--addr 127.0.0.1:${defaultPort}] [--dsn <postgres url>] [--fixed]`;
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        addr: { type: 'string', default: `127.0.0.1:${defaultPort}` },
        dsn: { type: 'string', default: PROXY_DSN },
        fixed: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${usage}`);
    process.exit(2);
  }
  const addr = /^(.*):(\d{1,5})$/.exec(values.addr);
  if (addr === null || Number(addr[2]) > 65535) {
    console.error(`invalid --addr ${JSON.stringify(values.addr)}: want host:port\n${usage}`);
    process.exit(2);
  }
  const pool = newPool(values.dsn);
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error(`warning: cannot reach Postgres at ${values.dsn} yet (${err instanceof Error ? err.message : String(err)}); will connect on the first request`);
  }
  const server = http.createServer(newHandler(pool, values.fixed));
  server.on('error', (err) => {
    console.error(`${name} victim: ${err.message}`);
    process.exit(1);
  });
  server.listen(Number(addr[2]), addr[1] === '' ? undefined : addr[1], () => {
    console.log(`${name} victim listening on http://${values.addr} (fixed=${values.fixed})`);
  });
}

// Entry point of the coupon victim:
//   node victims/coupon/main.ts [--addr 127.0.0.1:8081] [--dsn <postgres url>] [--fixed]
import http from 'node:http';
import { parseArgs } from 'node:util';
import { PROXY_DSN, newHandler, newPool } from './app.ts';

const usage = 'usage: node victims/coupon/main.ts [--addr 127.0.0.1:8081] [--dsn <postgres url>] [--fixed]';

let values;
try {
  ({ values } = parseArgs({
    options: {
      addr: { type: 'string', default: '127.0.0.1:8081' },
      // The default goes through Interleave's proxy; use port 5432 to bypass it.
      dsn: { type: 'string', default: PROXY_DSN },
      fixed: { type: 'boolean', default: false }, // the correct implementation (SELECT ... FOR UPDATE)
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
const host = addr[1];
const port = Number(addr[2]);

const pool = newPool(values.dsn);
try {
  await pool.query('SELECT 1');
} catch (err) {
  console.error(`cannot reach Postgres at ${values.dsn}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const server = http.createServer(newHandler(pool, values.fixed));
server.on('error', (err) => {
  console.error(`coupon victim: ${err.message}`);
  process.exit(1);
});
server.listen(port, host === '' ? undefined : host, () => {
  console.log(`coupon victim listening on http://${values.addr} (fixed=${values.fixed})`);
});

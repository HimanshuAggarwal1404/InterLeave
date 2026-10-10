// Entry point of the coupon victim:
//   node victims/coupon/main.ts [--addr 127.0.0.1:8081] [--dsn <postgres url>] [--fixed]
import http from 'node:http';
import { parseArgs } from 'node:util';
import { PROXY_DSN, newHandler, newPool } from './app.ts';

const { values } = parseArgs({
  options: {
    addr: { type: 'string', default: '127.0.0.1:8081' },
    // The default goes through Interleave's proxy; use port 5432 to bypass it.
    dsn: { type: 'string', default: PROXY_DSN },
    fixed: { type: 'boolean', default: false }, // the correct implementation (SELECT ... FOR UPDATE)
  },
});

const pool = newPool(values.dsn);
try {
  await pool.query('SELECT 1');
} catch (err) {
  console.error(`cannot reach Postgres at ${values.dsn}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const colon = values.addr.lastIndexOf(':');
const host = values.addr.slice(0, colon);
const port = Number(values.addr.slice(colon + 1));
const server = http.createServer(newHandler(pool, values.fixed));
server.on('error', (err) => {
  console.error(`coupon victim: ${err.message}`);
  process.exit(1);
});
server.listen(port, host === '' ? undefined : host, () => {
  console.log(`coupon victim listening on http://${values.addr} (fixed=${values.fixed})`);
});

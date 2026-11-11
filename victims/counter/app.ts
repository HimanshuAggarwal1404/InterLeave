// The counter victim: two page views counted at the same moment.
//
// POST /increment {"counter": "visits"} reads the counter, adds one in the
// app, and writes the new value back. Two concurrent increments can both read
// n and both write n + 1: one increment is lost.
// --fixed lets Postgres do the arithmetic: SET n = n + 1.
import type http from 'node:http';
import type pg from 'pg';
import { endpoint, sqlInt, sqlText, text, transaction, type Query, type Reply } from '../common/kit.ts';

export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return endpoint('/increment', async (body, tc) => {
    const counter = text(body, 'counter');
    return transaction(pool, tc, (q) => (fixed ? incrementFixed : incrementBuggy)(q, counter));
  });
}

async function incrementBuggy(q: Query, counter: string): Promise<Reply> {
  const { rows } = await q<{ n: number }>(`SELECT n FROM counters WHERE name = ${sqlText(counter)}`);
  if (rows.length === 0) {
    return [404, 'unknown counter'];
  }
  // THE BUG: n + 1 is computed from a value read earlier. If another
  // increment wrote in between, this overwrites it with the same number.
  await q(`UPDATE counters SET n = ${sqlInt(rows[0].n + 1)} WHERE name = ${sqlText(counter)}`);
  await q(`INSERT INTO increments (counter) VALUES (${sqlText(counter)})`);
  return [200, 'incremented'];
}

async function incrementFixed(q: Query, counter: string): Promise<Reply> {
  // THE FIX: the database adds one to the current value. A concurrent UPDATE
  // waits for this row lock and then adds one to the new value.
  const res = await q(`UPDATE counters SET n = n + 1 WHERE name = ${sqlText(counter)}`);
  if (res.rowCount === 0) {
    return [404, 'unknown counter'];
  }
  await q(`INSERT INTO increments (counter) VALUES (${sqlText(counter)})`);
  return [200, 'incremented'];
}

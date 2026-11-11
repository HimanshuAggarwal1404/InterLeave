// The username victim: two people sign up with the same username at once.
//
// POST /signup {"username": "himanshu"} checks that the name is free, then
// inserts it. Two concurrent signups for the same name can both find it free
// and both insert: the "unique" username now belongs to two members.
// --fixed takes an advisory lock on the name before checking.
import type http from 'node:http';
import type pg from 'pg';
import { endpoint, sqlText, text, transaction, type Query, type Reply } from '../common/kit.ts';

export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return endpoint('/signup', async (body, tc) => {
    const username = text(body, 'username');
    return transaction(pool, tc, (q) => signup(q, username, fixed));
  });
}

async function signup(q: Query, username: string, fixed: boolean): Promise<Reply> {
  if (fixed) {
    // THE FIX: there is no row to lock yet (the member does not exist), so
    // lock the name itself. An advisory lock is a lock on a number the app
    // chooses; pg_advisory_xact_lock waits until no other transaction holds
    // the same number and keeps it until COMMIT/ROLLBACK. Two signups for the
    // same name hash to the same number, so the second waits, and its check
    // below then sees the first member.
    await q(`SELECT pg_advisory_xact_lock(hashtext(${sqlText(username)}))`);
  }
  const taken = await q(`SELECT 1 FROM members WHERE username = ${sqlText(username)}`);
  if (taken.rows.length > 0) {
    return [409, 'username taken'];
  }
  // THE BUG (without the lock): another signup may have inserted the same
  // name since our check, and nothing (no unique index) stops a second row.
  await q(`INSERT INTO members (username) VALUES (${sqlText(username)})`);
  return [200, 'signed up'];
}

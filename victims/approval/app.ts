// The approval victim: two managers approve the same request at once.
//
// POST /approve {"request": 1, "approver": "asha"} reads the request, checks it
// is still pending, marks it approved and records who approved it. Two
// concurrent approvals can both see "pending": the request is approved twice
// (e.g. an expense paid out twice).
// --fixed uses optimistic locking: the UPDATE only succeeds if the request's
// version is still the one that was read.
import type http from 'node:http';
import type pg from 'pg';
import { endpoint, int, sqlInt, sqlText, text, transaction, type Query, type Reply } from '../common/kit.ts';

export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return endpoint('/approve', async (body, tc) => {
    const request = int(body, 'request');
    const approver = text(body, 'approver');
    return transaction(pool, tc, (q) => approve(q, request, approver, fixed));
  });
}

async function approve(q: Query, request: number, approver: string, fixed: boolean): Promise<Reply> {
  const { rows } = await q<{ status: string; version: number }>(
    `SELECT status, version FROM approval_requests WHERE id = ${sqlInt(request)}`,
  );
  if (rows.length === 0) {
    return [404, 'unknown request'];
  }
  if (rows[0].status !== 'pending') {
    return [409, 'already decided'];
  }
  const version = rows[0].version;
  if (fixed) {
    // THE FIX: only update if nobody changed the request since we read it.
    // A concurrent approval waits for the first one's row lock, then re-checks
    // the WHERE against the new row (version is now 2): no row matches.
    const res = await q(
      `UPDATE approval_requests SET status = 'approved', version = version + 1 WHERE id = ${sqlInt(request)} AND version = ${sqlInt(version)}`,
    );
    if (res.rowCount === 0) {
      return [409, 'already decided'];
    }
  } else {
    // THE BUG: the "still pending" check above may be stale by now, and this
    // UPDATE does not re-check it.
    await q(`UPDATE approval_requests SET status = 'approved', version = version + 1 WHERE id = ${sqlInt(request)}`);
  }
  await q(`INSERT INTO approvals (request_id, approver) VALUES (${sqlInt(request)}, ${sqlText(approver)})`);
  return [200, 'approved'];
}

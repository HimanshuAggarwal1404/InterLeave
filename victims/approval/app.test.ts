// Sequential behaviour of the approval victim. One request at a time there is
// no race, so the buggy and the fixed version must behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHandler } from './app.ts';
import { post, resetDB, startServer, testPool } from '../common/testutil.ts';

const SEED = new URL('./seed.sql', import.meta.url);

for (const fixed of [false, true]) {
  const variant = fixed ? 'fixed' : 'buggy';

  test(`ApprovesOnce (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/approve`;
    await resetDB(pool, SEED);

    assert.deepEqual(await post(url, { request: 1, approver: 'asha' }, { tag: 'A' }), { status: 200, body: 'approved' });
    assert.deepEqual(await post(url, { request: 1, approver: 'ravi' }, { tag: 'B' }), { status: 409, body: 'already decided' });
    assert.equal((await post(url, { request: 2, approver: 'asha' })).status, 404);

    const { rows } = await pool.query<{ status: string; version: number; approver: string }>(
      'SELECT r.status, r.version, a.approver FROM approval_requests r JOIN approvals a ON a.request_id = r.id',
    );
    assert.deepEqual(rows, [{ status: 'approved', version: 2, approver: 'asha' }]);
  });

  test(`RejectsBadApprovals (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/approve`;
    await resetDB(pool, SEED);

    for (const body of [{ request: 1 }, { approver: 'asha' }, { request: '1', approver: 'asha' }]) {
      assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    }
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM approval_requests WHERE id = 1');
    assert.deepEqual(rows, [{ status: 'pending' }]);
  });
}

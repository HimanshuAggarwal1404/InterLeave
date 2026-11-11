// Sequential behaviour of the transfer victim. One request at a time there is
// no race, so the buggy and the fixed version must behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHandler } from './app.ts';
import { post, resetDB, startServer, testPool } from '../common/testutil.ts';

const SEED = new URL('./seed.sql', import.meta.url);

for (const fixed of [false, true]) {
  const variant = fixed ? 'fixed' : 'buggy';

  test(`MovesMoneyWhileFundsLast (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/transfer`;
    await resetDB(pool, SEED);

    assert.deepEqual(await post(url, { from: 1, to: 2, amount: 30 }, { tag: 'A' }), { status: 200, body: 'transferred' });
    assert.deepEqual(await post(url, { from: 2, to: 1, amount: 10 }, { tag: 'B' }), { status: 200, body: 'transferred' });
    assert.deepEqual(await post(url, { from: 1, to: 2, amount: 81 }), { status: 409, body: 'insufficient funds' });
    assert.equal((await post(url, { from: 1, to: 3, amount: 5 })).status, 404);

    const { rows } = await pool.query<{ id: number; balance: number }>('SELECT id, balance FROM accounts ORDER BY id');
    assert.deepEqual(rows, [{ id: 1, balance: 80 }, { id: 2, balance: 120 }]);
  });

  test(`RejectsBadTransfers (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/transfer`;
    await resetDB(pool, SEED);

    for (const body of [
      { from: 1, to: 1, amount: 10 },
      { from: 1, to: 2, amount: 0 },
      { from: 1, amount: 10 },
      { to: 2, amount: 10 },
      { from: 1, to: 2 },
    ]) {
      assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    }
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM transfers');
    assert.deepEqual(rows, [{ n: 0 }]);
  });
}

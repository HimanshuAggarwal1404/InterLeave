// Sequential behaviour of the wallet victim. One request at a time there is
// no race, so the buggy and the fixed version must behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHandler } from './app.ts';
import { post, resetDB, startServer, testPool } from '../common/testutil.ts';

const SEED = new URL('./seed.sql', import.meta.url);

for (const fixed of [false, true]) {
  const variant = fixed ? 'fixed' : 'buggy';

  test(`WithdrawsWhileFundsLast (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/withdraw`;
    await resetDB(pool, SEED);

    assert.deepEqual(await post(url, { wallet: 1, amount: 70 }, { tag: 'A' }), { status: 200, body: 'withdrawn' });
    assert.deepEqual(await post(url, { wallet: 1, amount: 70 }, { tag: 'B' }), { status: 409, body: 'insufficient funds' });
    assert.equal((await post(url, { wallet: 2, amount: 10 })).status, 404);

    const { rows } = await pool.query<{ balance: number; n: number }>(
      'SELECT balance, (SELECT count(*)::int FROM withdrawals) AS n FROM wallets WHERE id = 1',
    );
    assert.deepEqual(rows, [{ balance: 30, n: 1 }]);
  });

  test(`RejectsBadWithdrawals (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/withdraw`;
    await resetDB(pool, SEED);

    for (const body of [{ wallet: 1, amount: 0 }, { wallet: 1, amount: -5 }, { wallet: 1 }, { amount: 10 }]) {
      assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    }
    const { rows } = await pool.query<{ balance: number }>('SELECT balance FROM wallets WHERE id = 1');
    assert.deepEqual(rows, [{ balance: 100 }]);
  });
}

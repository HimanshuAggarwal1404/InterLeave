// Sequential behaviour of the inventory victim. One request at a time there
// is no race, so the buggy and the fixed version must behave the same.
// (The race itself is found by Interleave: victims/acceptance.e2e.ts.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHandler } from './app.ts';
import { post, resetDB, startServer, testPool } from '../common/testutil.ts';

const SEED = new URL('./seed.sql', import.meta.url);

for (const fixed of [false, true]) {
  const variant = fixed ? 'fixed' : 'buggy';

  test(`OrdersUntilOutOfStock (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/order`;
    await resetDB(pool, SEED);

    assert.deepEqual(await post(url, { product: 'widget', qty: 1, user_id: 1 }, { tag: 'A' }), { status: 200, body: 'ordered' });
    assert.deepEqual(await post(url, { product: 'widget', qty: 1, user_id: 2 }, { tag: 'B' }), { status: 409, body: 'out of stock' });
    assert.equal((await post(url, { product: 'gadget', qty: 1, user_id: 3 })).status, 404);

    const { rows } = await pool.query<{ stock: number; orders: string }>(
      "SELECT stock, (SELECT count(*) FROM orders) AS orders FROM products WHERE name = 'widget'",
    );
    assert.deepEqual(rows, [{ stock: 0, orders: '1' }]);
  });

  test(`RejectsBadOrders (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/order`;
    await resetDB(pool, SEED);

    for (const body of [
      { product: 'widget', qty: 0, user_id: 1 },
      { product: 'widget', qty: 1.5, user_id: 1 },
      { qty: 1, user_id: 1 },
      { product: 'widget', qty: 1 },
    ]) {
      assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    }
    const { rows } = await pool.query<{ stock: number }>("SELECT stock FROM products WHERE name = 'widget'");
    assert.deepEqual(rows, [{ stock: 1 }], 'a rejected order must not change the stock');
  });
}

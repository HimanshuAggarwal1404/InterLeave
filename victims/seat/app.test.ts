// Sequential behaviour of the seat victim. One request at a time there is no
// race, so the buggy and the fixed version must behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHandler } from './app.ts';
import { post, resetDB, startServer, testPool } from '../common/testutil.ts';

const SEED = new URL('./seed.sql', import.meta.url);

for (const fixed of [false, true]) {
  const variant = fixed ? 'fixed' : 'buggy';

  test(`BooksASeatOnce (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/book`;
    await resetDB(pool, SEED);

    assert.deepEqual(await post(url, { seat: '12A', user_id: 1 }, { tag: 'A' }), { status: 200, body: 'booked' });
    assert.deepEqual(await post(url, { seat: '12A', user_id: 2 }, { tag: 'B' }), { status: 409, body: 'seat taken' });
    assert.equal((await post(url, { seat: '99Z', user_id: 3 })).status, 404);

    const { rows } = await pool.query<{ user_id: number }>("SELECT user_id FROM bookings WHERE seat = '12A'");
    assert.deepEqual(rows, [{ user_id: 1 }]);
  });

  test(`RejectsBadBookings (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/book`;
    await resetDB(pool, SEED);

    for (const body of [{ user_id: 1 }, { seat: '12A' }, { seat: 12, user_id: 1 }, { seat: '12A', user_id: '1' }]) {
      assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    }
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM bookings');
    assert.deepEqual(rows, [{ n: 0 }]);
  });
}

// Sequential behaviour of the counter victim. One request at a time there is
// no race, so the buggy and the fixed version must behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHandler } from './app.ts';
import { post, resetDB, startServer, testPool } from '../common/testutil.ts';

const SEED = new URL('./seed.sql', import.meta.url);

for (const fixed of [false, true]) {
  const variant = fixed ? 'fixed' : 'buggy';

  test(`CountsEveryIncrement (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/increment`;
    await resetDB(pool, SEED);

    assert.deepEqual(await post(url, { counter: 'visits' }, { tag: 'A' }), { status: 200, body: 'incremented' });
    assert.deepEqual(await post(url, { counter: 'visits' }, { tag: 'B' }), { status: 200, body: 'incremented' });
    assert.equal((await post(url, { counter: 'clicks' })).status, 404);

    const { rows } = await pool.query<{ n: number; logged: number }>(
      "SELECT n, (SELECT count(*)::int FROM increments) AS logged FROM counters WHERE name = 'visits'",
    );
    assert.deepEqual(rows, [{ n: 2, logged: 2 }]);
  });

  test(`RejectsBadIncrements (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/increment`;
    await resetDB(pool, SEED);

    for (const body of [{}, { counter: 1 }, { name: 'visits' }]) {
      assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    }
    const { rows } = await pool.query<{ n: number }>("SELECT n FROM counters WHERE name = 'visits'");
    assert.deepEqual(rows, [{ n: 0 }]);
  });
}

// Sequential behaviour of the username victim. One request at a time there is
// no race, so the buggy and the fixed version must behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHandler } from './app.ts';
import { post, resetDB, startServer, testPool } from '../common/testutil.ts';

const SEED = new URL('./seed.sql', import.meta.url);

for (const fixed of [false, true]) {
  const variant = fixed ? 'fixed' : 'buggy';

  test(`SignsUpEachNameOnce (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/signup`;
    await resetDB(pool, SEED);

    assert.deepEqual(await post(url, { username: 'himanshu' }, { tag: 'A' }), { status: 200, body: 'signed up' });
    assert.deepEqual(await post(url, { username: 'himanshu' }, { tag: 'B' }), { status: 409, body: 'username taken' });
    assert.equal((await post(url, { username: 'asha' })).status, 200);

    const { rows } = await pool.query<{ username: string }>('SELECT username FROM members ORDER BY id');
    assert.deepEqual(rows, [{ username: 'himanshu' }, { username: 'asha' }]);
  });

  test(`RejectsBadSignups (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = `${await startServer(t, newHandler(pool, fixed))}/signup`;
    await resetDB(pool, SEED);

    for (const body of [{}, { username: 7 }, { name: 'himanshu' }]) {
      assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    }
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM members');
    assert.deepEqual(rows, [{ n: 0 }]);
  });
}

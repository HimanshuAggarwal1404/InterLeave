// Sequential behaviour of the ledger victim. One request at a time there is
// no race, so the buggy and the fixed version must behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHandler } from './app.ts';
import { post, resetDB, startServer, testPool } from '../common/testutil.ts';

const SEED = new URL('./seed.sql', import.meta.url);

for (const fixed of [false, true]) {
  const variant = fixed ? 'fixed' : 'buggy';

  test(`DepositsAndClosesTheMonth (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = await startServer(t, newHandler(pool, fixed));
    await resetDB(pool, SEED);

    assert.deepEqual(await post(`${url}/deposit`, { account: 1, amount: 50 }, { tag: 'A' }), { status: 200, body: 'deposited' });
    assert.deepEqual(await post(`${url}/close`, { account: 1, fee: 10 }, { tag: 'B' }), { status: 200, body: 'closed' });
    assert.equal((await post(`${url}/deposit`, { account: 2, amount: 5 })).status, 404);
    assert.equal((await post(`${url}/close`, { account: 2, fee: 5 })).status, 404);

    const { rows } = await pool.query<{ balance: number; entries: number; audit: number }>(
      'SELECT balance, (SELECT count(*)::int FROM ledger_entries) AS entries, (SELECT count(*)::int FROM ledger_audit) AS audit FROM ledger_accounts WHERE id = 1',
    );
    assert.deepEqual(rows, [{ balance: 140, entries: 2, audit: 8 }], 'the failed close for account 2 must leave no audit lines');
  });

  test(`RejectsBadRequests (${variant})`, async (t) => {
    const pool = await testPool(t);
    if (!pool) return;
    const url = await startServer(t, newHandler(pool, fixed));
    await resetDB(pool, SEED);

    for (const [path, body] of [
      ['/deposit', { account: 1, amount: 0 }],
      ['/deposit', { amount: 5 }],
      ['/close', { account: 1, fee: -1 }],
      ['/close', { account: 1 }],
    ] as const) {
      assert.equal((await post(`${url}${path}`, body)).status, 400, `${path} ${JSON.stringify(body)}`);
    }
    assert.equal((await post(`${url}/other`, { account: 1 })).status, 404);
    const { rows } = await pool.query<{ balance: number }>('SELECT balance FROM ledger_accounts WHERE id = 1');
    assert.deepEqual(rows, [{ balance: 100 }]);
  });
}

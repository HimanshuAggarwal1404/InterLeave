// The wallet victim: two withdrawals from the same wallet at the same moment.
//
// POST /withdraw {"wallet": 1, "amount": 70} reads the balance, checks it
// covers the amount, then subtracts it. Two concurrent withdrawals of 70 from
// a balance of 100 can both pass the check: the balance goes to -40.
// --fixed runs the same code at SERIALIZABLE isolation and retries when
// Postgres aborts it with a serialization failure (SQLSTATE 40001).
import type http from 'node:http';
import type pg from 'pg';
import { BadRequest, endpoint, int, sqlInt, sqlState, transaction, type Query, type Reply } from '../common/kit.ts';

const MAX_ATTEMPTS = 5;

export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return endpoint('/withdraw', async (body, tc) => {
    const wallet = int(body, 'wallet');
    const amount = int(body, 'amount');
    if (amount < 1) {
      throw new BadRequest('amount: want at least 1');
    }
    if (!fixed) {
      return transaction(pool, tc, (q) => withdraw(q, wallet, amount));
    }
    // THE FIX: at SERIALIZABLE, Postgres guarantees the result is the same as
    // running the transactions one after the other. When it cannot (here: the
    // second withdrawal updates a row the first changed after the second took
    // its snapshot), it aborts one with 40001. Retrying from the start re-reads
    // the new balance, so the check is no longer stale.
    for (let attempt = 1; ; attempt++) {
      try {
        return await transaction(pool, tc, (q) => withdraw(q, wallet, amount), 'SERIALIZABLE');
      } catch (err) {
        if (sqlState(err) !== '40001' || attempt === MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
  });
}

async function withdraw(q: Query, wallet: number, amount: number): Promise<Reply> {
  const { rows } = await q<{ balance: number }>(`SELECT balance FROM wallets WHERE id = ${sqlInt(wallet)}`);
  if (rows.length === 0) {
    return [404, 'unknown wallet'];
  }
  if (rows[0].balance < amount) {
    return [409, 'insufficient funds'];
  }
  // THE BUG (at the default READ COMMITTED): the balance may have changed
  // since the SELECT; the UPDATE subtracts from the new balance anyway.
  await q(`UPDATE wallets SET balance = balance - ${sqlInt(amount)} WHERE id = ${sqlInt(wallet)}`);
  await q(`INSERT INTO withdrawals (wallet, amount) VALUES (${sqlInt(wallet)}, ${sqlInt(amount)})`);
  return [200, 'withdrawn'];
}

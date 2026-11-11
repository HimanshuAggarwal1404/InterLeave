// The transfer victim: two transfers out of the same account at once.
//
// POST /transfer {"from": 1, "to": 2, "amount": 30} reads both balances,
// computes the new ones in the app, and writes them back as absolute values.
// When two transfers overlap, the second write overwrites the first (a lost
// update): money moves twice in the log but only once in the balances.
// --fixed locks both rows (in id order) before reading them.
import type http from 'node:http';
import type pg from 'pg';
import { BadRequest, endpoint, int, sqlInt, transaction, type Query, type Reply } from '../common/kit.ts';

export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return endpoint('/transfer', async (body, tc) => {
    const from = int(body, 'from');
    const to = int(body, 'to');
    const amount = int(body, 'amount');
    if (amount < 1) {
      throw new BadRequest('amount: want at least 1');
    }
    if (from === to) {
      throw new BadRequest('from and to: want two different accounts');
    }
    return transaction(pool, tc, (q) => transfer(q, from, to, amount, fixed));
  });
}

async function transfer(q: Query, from: number, to: number, amount: number, fixed: boolean): Promise<Reply> {
  // THE FIX: FOR UPDATE locks both rows until the transaction ends, so no
  // other transfer can read them in between. Locking in id order (ORDER BY id)
  // means two transfers in opposite directions take the locks in the same
  // order and cannot deadlock.
  const lock = fixed ? ' FOR UPDATE' : '';
  const { rows } = await q<{ id: number; balance: number }>(
    `SELECT id, balance FROM accounts WHERE id IN (${sqlInt(from)}, ${sqlInt(to)}) ORDER BY id${lock}`,
  );
  const balance = new Map(rows.map((r) => [r.id, r.balance]));
  const fromBalance = balance.get(from);
  const toBalance = balance.get(to);
  if (fromBalance === undefined || toBalance === undefined) {
    return [404, 'unknown account'];
  }
  if (fromBalance < amount) {
    return [409, 'insufficient funds'];
  }
  // THE BUG (without the lock): these balances were computed from values read
  // earlier. If another transfer changed the rows since, its change is lost.
  await q(`UPDATE accounts SET balance = ${sqlInt(fromBalance - amount)} WHERE id = ${sqlInt(from)}`);
  await q(`UPDATE accounts SET balance = ${sqlInt(toBalance + amount)} WHERE id = ${sqlInt(to)}`);
  await q(`INSERT INTO transfers (from_account, to_account, amount) VALUES (${sqlInt(from)}, ${sqlInt(to)}, ${sqlInt(amount)})`);
  return [200, 'transferred'];
}

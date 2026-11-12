// The ledger victim: a benchmark for comparing exploration strategies (D-032).
//
// POST /deposit {"account": 1, "amount": 50} reads the balance and writes back
// balance + amount, computed in the app. POST /close {"account": 1, "fee": 10}
// is a month-end close: a long transaction (8 audit lines, then the fee).
// If a deposit reads the balance, then the whole close runs, and only then the
// deposit writes, the fee is lost (a lost update). That needs one preemption at
// exactly the right place followed by a long uninterrupted stretch of the
// close: easy for PCT, rare for random choices, late for exhaustive DFS.
// --fixed deposits with SET balance = balance + amount.
import type http from 'node:http';
import type pg from 'pg';
import { BadRequest, endpoint, int, sqlInt, transaction, type Query, type Reply } from '../common/kit.ts';

const AUDIT_LINES = 8;

export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  const deposit = endpoint('/deposit', async (body, tc) => {
    const account = int(body, 'account');
    const amount = positive(body, 'amount');
    return transaction(pool, tc, (q) => (fixed ? depositFixed : depositBuggy)(q, account, amount));
  });
  const close = endpoint('/close', async (body, tc) => {
    const account = int(body, 'account');
    const fee = positive(body, 'fee');
    return transaction(pool, tc, (q) => closeMonth(q, account, fee));
  });
  return (req, res) => (new URL(req.url ?? '/', 'http://localhost').pathname === '/close' ? close : deposit)(req, res);
}

function positive(body: Record<string, unknown>, field: string): number {
  const n = int(body, field);
  if (n < 1) {
    throw new BadRequest(`${field}: want at least 1`);
  }
  return n;
}

async function depositBuggy(q: Query, account: number, amount: number): Promise<Reply> {
  const { rows } = await q<{ balance: number }>(`SELECT balance FROM ledger_accounts WHERE id = ${sqlInt(account)}`);
  if (rows.length === 0) {
    return [404, 'unknown account'];
  }
  // THE BUG: the new balance is computed from a value read earlier. If the
  // close took its fee in between, this write overwrites it.
  await q(`UPDATE ledger_accounts SET balance = ${sqlInt(rows[0].balance + amount)} WHERE id = ${sqlInt(account)}`);
  await q(`INSERT INTO ledger_entries (account, kind, amount) VALUES (${sqlInt(account)}, 'deposit', ${sqlInt(amount)})`);
  return [200, 'deposited'];
}

async function depositFixed(q: Query, account: number, amount: number): Promise<Reply> {
  // THE FIX: the database adds to the current balance, after waiting for any
  // transaction that changed it.
  const res = await q(`UPDATE ledger_accounts SET balance = balance + ${sqlInt(amount)} WHERE id = ${sqlInt(account)}`);
  if (res.rowCount === 0) {
    return [404, 'unknown account'];
  }
  await q(`INSERT INTO ledger_entries (account, kind, amount) VALUES (${sqlInt(account)}, 'deposit', ${sqlInt(amount)})`);
  return [200, 'deposited'];
}

// closeMonth is the long transaction: audit lines first, then the fee. It is
// correct on its own (SET balance = balance - fee); the race is in deposit.
async function closeMonth(q: Query, account: number, fee: number): Promise<Reply> {
  for (let line = 1; line <= AUDIT_LINES; line++) {
    await q(`INSERT INTO ledger_audit (account, line) VALUES (${sqlInt(account)}, ${sqlInt(line)})`);
  }
  const res = await q(`UPDATE ledger_accounts SET balance = balance - ${sqlInt(fee)} WHERE id = ${sqlInt(account)}`);
  if (res.rowCount === 0) {
    return [404, 'unknown account']; // rolled back, audit lines included
  }
  await q(`INSERT INTO ledger_entries (account, kind, amount) VALUES (${sqlInt(account)}, 'fee', ${sqlInt(fee)})`);
  return [200, 'closed'];
}

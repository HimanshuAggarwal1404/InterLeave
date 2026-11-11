# transfer victim

**Bug:** `POST /transfer` reads both balances, computes the new ones in the app and writes them
back as absolute values, so when two transfers overlap the second write overwrites the first (a
lost update): the log shows both transfers, the balances only one.

## Bad interleaving

Accounts 1 and 2 start at 100. A sends 30 from 1 to 2, B sends 20 from 1 to 2.

```
Request A                                  Request B
BEGIN
SELECT id, balance ... → 1: 100, 2: 100
                                           BEGIN
                                           SELECT id, balance ... → 1: 100, 2: 100
UPDATE accounts SET balance = 70 WHERE id = 1
UPDATE accounts SET balance = 130 WHERE id = 2
INSERT INTO transfers (1, 2, 30)
COMMIT
                                           UPDATE accounts SET balance = 80 WHERE id = 1
                                           UPDATE accounts SET balance = 120 WHERE id = 2
                                           INSERT INTO transfers (1, 2, 20)
                                           COMMIT     → balances 80 / 120, but 50 left account 1
```

The total is still 200, so "no money created or destroyed" holds. The second invariant compares
each balance with the log (100 - sent + received = 50 for account 1) and catches it.

## Fix (`--fixed`): lock both rows, in id order

`SELECT id, balance FROM accounts WHERE id IN (1, 2) ORDER BY id FOR UPDATE` locks both rows until
the transaction ends. B's `SELECT ... FOR UPDATE` waits for A's commit and then reads 70 / 130, so
its absolute writes are correct. Locking in id order matters: a transfer 1 → 2 and one 2 → 1 lock
the rows in the same order (1, then 2), so neither can hold one row while waiting for the other,
and they cannot deadlock.

(Writing `SET balance = balance - 30` would also avoid the lost update, but the check
"enough money?" would still read a stale balance; see the wallet victim.)

## Run it

```bash
node victims/transfer/main.ts                  # buggy, on 127.0.0.1:8086, database via 127.0.0.1:6433
npm run interleave -- run victims/transfer/scenario.yaml
```

# wallet victim

**Bug:** `POST /withdraw` reads the balance, checks it covers the amount, then subtracts it, so two
concurrent withdrawals of 70 from a balance of 100 can both pass the check: the balance goes to -40.

## Bad interleaving

```
Request A                                  Request B
BEGIN
SELECT balance → 100
                                           BEGIN
                                           SELECT balance → 100
UPDATE wallets SET balance = balance - 70
                                           UPDATE wallets SET balance = balance - 70   (waits for A's row lock)
INSERT INTO withdrawals ...
COMMIT
                                           (the UPDATE goes on from 30)  → balance = -40
                                           INSERT INTO withdrawals ...
                                           COMMIT
```

## Fix (`--fixed`): SERIALIZABLE isolation and retry

The same code runs inside `BEGIN ISOLATION LEVEL SERIALIZABLE`. Postgres then guarantees the
outcome equals some one-at-a-time order of the transactions. In the timeline above, B's `UPDATE`
targets a row that A changed after B's snapshot was taken, so Postgres aborts B with SQLSTATE
`40001` ("could not serialize access due to concurrent update"). The app rolls back and retries
the whole transaction (up to 5 attempts); the retry reads the balance 30 and answers 409.

This fix takes no explicit lock: Postgres detects the conflict, and the app pays for it with
retries. Every app that uses SERIALIZABLE must be ready to retry.

## Run it

```bash
node victims/wallet/main.ts                    # buggy, on 127.0.0.1:8084, database via 127.0.0.1:6433
npm run interleave -- run victims/wallet/scenario.yaml
```

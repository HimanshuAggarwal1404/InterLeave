# ledger victim (strategy benchmark)

**Bug:** `POST /deposit` reads the balance and writes back `balance + amount` computed in the app,
so if the month-end close (`POST /close`, a long transaction) takes its fee between the deposit's
read and write, the deposit's write overwrites it: the fee is lost.

This victim exists to compare exploration strategies (D-032). Its bad order needs **one
preemption at exactly the right place** (stop the deposit right after its read) **followed by a
long uninterrupted stretch** of the other request (the whole close: 8 audit lines, the fee, the
commit). Random choices rarely give one request that many turns in a row, and exhaustive
depth-first search reaches that order late. PCT (`--strategy pct --depth 2`) is built for exactly
this kind of bug.

## Bad interleaving

```
Request A (deposit 50)                     Request B (close, fee 10)
BEGIN
SELECT balance → 100
                                           BEGIN
                                           INSERT INTO ledger_audit ... (8 lines)
                                           UPDATE ledger_accounts SET balance = balance - 10   → 90
                                           INSERT INTO ledger_entries (fee 10)
                                           COMMIT
UPDATE ledger_accounts SET balance = 150   (100 + 50, from the stale read: the fee is gone)
INSERT INTO ledger_entries (deposit 50)
COMMIT                                     → balance 150, but 100 + 50 - 10 = 140
```

## Fix (`--fixed`)

The deposit uses `UPDATE ledger_accounts SET balance = balance + 50`: the database adds to the
current balance after waiting for the close's row lock (READ COMMITTED re-reads the row for an
UPDATE), so nothing is overwritten.

## Run it

```bash
node victims/ledger/main.ts                    # buggy, on 127.0.0.1:8089, database via 127.0.0.1:6433
npm run interleave -- run victims/ledger/scenario.yaml --strategy pct
npm run compare                                # exhaustive vs random vs PCT, 10 seeds each
```

The fixed variant has thousands of orders, too many to explore completely in a test; the
comparison script checks it with exhaustive (1000 orders), random and PCT (300 runs each).

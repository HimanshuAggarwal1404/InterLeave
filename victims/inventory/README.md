# inventory victim

**Bug:** `POST /order` checks the stock with a plain `SELECT`, then decrements it in a separate
`UPDATE`, so two concurrent orders for the last item can both pass the check: the stock goes to -1.

## Bad interleaving

```
Request A                                  Request B
BEGIN
SELECT stock → 1
                                           BEGIN
                                           SELECT stock → 1      (A has not written yet)
UPDATE products SET stock = stock - 1
INSERT INTO orders ...
COMMIT
                                           UPDATE products SET stock = stock - 1   → stock = -1
                                           INSERT INTO orders ...
                                           COMMIT
```

## Fix (`--fixed`): check and act in one statement

`UPDATE products SET stock = stock - 1 WHERE name = 'widget' AND stock >= 1`, then check it changed
a row. When B's `UPDATE` reaches the row, it waits for A's transaction to finish and then re-checks
its `WHERE` against the newest version of the row (READ COMMITTED does this for UPDATE). It finds
`stock = 0`, changes no row, and B answers 409. No separate check can go stale, because there is
none.

## Run it

```bash
node victims/inventory/main.ts                 # buggy, on 127.0.0.1:8082, database via 127.0.0.1:6433
npm run interleave -- run victims/inventory/scenario.yaml
```
`--fixed` runs the fixed version; `--dsn` with port 5432 talks to Postgres directly.

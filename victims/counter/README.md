# counter victim

**Bug:** `POST /increment` reads the counter, adds one in the app and writes the result back, so
two concurrent increments can both read the same value and both write it plus one: an increment is
lost (the classic lost update).

## Bad interleaving

```
Request A                                  Request B
BEGIN
SELECT n → 0
                                           BEGIN
                                           SELECT n → 0
UPDATE counters SET n = 1
INSERT INTO increments ...
COMMIT
                                           UPDATE counters SET n = 1     (should be 2)
                                           INSERT INTO increments ...
                                           COMMIT      → n = 1, but 2 increments happened
```

## Fix (`--fixed`): let the database do the arithmetic

`UPDATE counters SET n = n + 1 WHERE name = 'visits'`. B's `UPDATE` waits for A's row lock and,
once A commits, re-evaluates `n + 1` on the newest row (READ COMMITTED does this for UPDATE), so it
writes 2. The read and the write are one atomic statement, so there is no stale value to write
back.

## Run it

```bash
node victims/counter/main.ts                   # buggy, on 127.0.0.1:8088, database via 127.0.0.1:6433
npm run interleave -- run victims/counter/scenario.yaml
```

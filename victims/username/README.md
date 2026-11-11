# username victim

**Bug:** `POST /signup` checks that the username is free and then inserts it, so two concurrent
signups for the same name can both find it free and both insert: two members share one username.

## Bad interleaving

```
Request A                                  Request B
BEGIN
                                           BEGIN
SELECT 1 FROM members WHERE username = 'himanshu'   → none
                                           SELECT 1 FROM members WHERE username = 'himanshu'   → none
INSERT INTO members ('himanshu')
COMMIT
                                           INSERT INTO members ('himanshu')
                                           COMMIT              → two members named himanshu
```

## Fix (`--fixed`): an advisory lock on the name

`SELECT ... FOR UPDATE` cannot help here: the row we would lock does not exist yet. Instead the
app locks the name itself: `SELECT pg_advisory_xact_lock(hashtext('himanshu'))`. An advisory lock
is a lock on a number the app chooses; Postgres attaches no meaning to it. Both signups hash the
same name to the same number, so B waits until A's transaction ends (the `_xact_` variant releases
the lock at COMMIT or ROLLBACK). B's check then sees A's member, and B answers 409.

The usual production fix is a `UNIQUE` constraint on `username`, which makes the second `INSERT`
fail; the advisory lock shows how to serialise work on something that has no row yet.

## Run it

```bash
node victims/username/main.ts                  # buggy, on 127.0.0.1:8085, database via 127.0.0.1:6433
npm run interleave -- run victims/username/scenario.yaml
```

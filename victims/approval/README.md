# approval victim

**Bug:** `POST /approve` checks that the request is still pending, then marks it approved and
records the approval, so two concurrent approvals can both see "pending": the request is approved
twice (in a real system, e.g. an expense paid out twice).

## Bad interleaving

```
Request A (asha)                           Request B (ravi)
BEGIN
SELECT status, version → pending, 1
                                           BEGIN
                                           SELECT status, version → pending, 1
UPDATE approval_requests SET status = 'approved', version = version + 1
INSERT INTO approvals (1, 'asha')
COMMIT
                                           UPDATE approval_requests SET status = 'approved', ...
                                           INSERT INTO approvals (1, 'ravi')
                                           COMMIT        → two approvals for request 1
```

## Fix (`--fixed`): optimistic locking with a version column

The `UPDATE` only applies if the row still has the version that was read:
`UPDATE approval_requests SET status = 'approved', version = version + 1 WHERE id = 1 AND version = 1`.
B's `UPDATE` waits for A's row lock; when A commits, Postgres re-checks B's `WHERE` against the new
row (READ COMMITTED does this for UPDATE). The version is now 2, no row matches, `rowCount` is 0,
and B answers 409 without inserting an approval.

"Optimistic" because nothing is locked while the app thinks: it just detects, at write time, that
someone else got there first. `SELECT ... FOR UPDATE` (pessimistic locking, see the seat victim)
would also work.

## Run it

```bash
node victims/approval/main.ts                  # buggy, on 127.0.0.1:8087, database via 127.0.0.1:6433
npm run interleave -- run victims/approval/scenario.yaml
```

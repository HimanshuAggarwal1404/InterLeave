# coupon victim

**Bug:** `POST /redeem` checks a coupon's use count with a plain `SELECT`, then increments it in a
separate `UPDATE`, so two concurrent requests can both pass the check and redeem a single-use
coupon twice (check-then-act).

## Bad interleaving

```
Request A                                Request B
BEGIN
SELECT uses, max_uses → 0, 1
                                         BEGIN
                                         SELECT uses, max_uses → 0, 1   (A has not written yet)
UPDATE coupons SET uses = uses + 1
INSERT INTO redemptions ...
COMMIT
                                         UPDATE coupons SET uses = uses + 1   → uses = 2
                                         INSERT INTO redemptions ...
                                         COMMIT
```

`BEGIN` alone does not help: under READ COMMITTED (the Postgres default) a plain `SELECT` takes
no lock, so B reads the row while A is still deciding.

## Fix

Lock the row while checking: `SELECT uses, max_uses FROM coupons WHERE code = $1 FOR UPDATE`
inside the transaction. B's `SELECT ... FOR UPDATE` then waits until A commits and reads
`uses = 1`, so B is rejected. An alternative is one conditional statement:
`UPDATE coupons SET uses = uses + 1 WHERE code = $1 AND uses < max_uses` and checking that it
updated one row, because a single `UPDATE` re-checks its `WHERE` on the latest row version.

## Run it

```bash
psql "postgresql://interleave:interleave@localhost:5432/interleave" -f victims/coupon/seed.sql
go run ./victims/coupon --dsn "postgres://interleave:interleave@localhost:5432/interleave?sslmode=disable&default_query_exec_mode=simple_protocol"
curl -X POST localhost:8081/redeem -d '{"code":"DIWALI50","user_id":1}'
```

Without `--dsn` the app connects through Interleave's proxy on port 6433.
Phase 0 exit test (blasts 50 concurrent redeems directly at Postgres):
`go test ./victims/coupon -run TestRaceIsReal -v`

Request tags: send `-H "X-Interleave-Req: A"` and every statement, including `BEGIN`/`COMMIT`, starts
with `/* il:req=A */` (pgx's `rollback` cannot be tagged). Other header values get 400, because the
tag is pasted into SQL. Without the header nothing is tagged.
`TestQueriesCarryRequestTag` checks this through a real proxy.

Still to come: `--fixed` (Phase 1), `scenario.yaml` (Phase 2).

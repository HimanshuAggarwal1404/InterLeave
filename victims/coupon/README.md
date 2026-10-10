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

Lock the row while checking: `SELECT uses, max_uses FROM coupons WHERE code = '...' FOR UPDATE`
inside the transaction. B's `SELECT ... FOR UPDATE` then waits until A commits and reads
`uses = 1`, so B is rejected. An alternative is one conditional statement:
`UPDATE coupons SET uses = uses + 1 WHERE code = '...' AND uses < max_uses` and checking that it
updated one row, because a single `UPDATE` re-checks its `WHERE` on the latest row version.

## Files

- `app.ts`: the handler and `redeem` (the bug, and the fix behind `--fixed`).
- `main.ts`: flags (`--addr`, default `127.0.0.1:8081`; `--dsn`; `--fixed`) and the HTTP server.
- `seed.sql`: creates the tables if needed and resets them to one unused, single-use coupon.
- `app.test.ts`: the Phase 0 exit test and the other app tests; `kill.spec.ts`: the Phase 1 exit test.

Every statement is sent as plain text with no values array, so node-postgres uses the simple
query protocol that Interleave schedules. The code is inlined with `escapeLiteral`, the user id
only after checking it is an integer.

## Run it

```bash
psql "postgresql://interleave:interleave@127.0.0.1:5432/interleave" -f victims/coupon/seed.sql
node victims/coupon/main.ts --dsn "postgres://interleave:interleave@127.0.0.1:5432/interleave?sslmode=disable"
curl -X POST http://127.0.0.1:8081/redeem -d '{"code":"DIWALI50","user_id":1}'
```

Without `--dsn` the app connects through Interleave's proxy on `127.0.0.1:6433`.
Phase 0 exit test (blasts 50 concurrent redeems directly at Postgres):
`node --test --test-name-pattern=RaceIsReal victims/coupon/app.test.ts`

Request tags: send `-H "X-Interleave-Req: A"` and every statement the app sends, `BEGIN`, `COMMIT`
and `ROLLBACK` included, starts with `/* il:req=A */` (D-021). Other header values get 400, because
the tag is pasted into SQL. Without the header nothing is tagged.
`QueriesCarryRequestTag` checks this through a real proxy.

Fixed variant: `node victims/coupon/main.ts --fixed` uses `SELECT ... FOR UPDATE`.
`FixedNeverOverRedeems` blasts it like `RaceIsReal` (20 rounds of 50 requests): never more
than one redemption.

Kill test (Phase 1 exit, `kill.spec.ts`): requests A and B go through a real proxy whose scheduler
releases their statements in a fixed order. The bad order (A BEGIN, A SELECT, B BEGIN, B SELECT,
then A's UPDATE/INSERT/COMMIT, then B's) must double-redeem 10/10 times; the serial order (all of A,
then B's BEGIN, SELECT and ROLLBACK) never may. It needs `src/sched`, so it runs only with
`npm run test:sched` until then.

Still to come: `scenario.yaml` (Phase 2).

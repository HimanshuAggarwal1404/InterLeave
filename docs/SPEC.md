# RaceHound: MVP Specification

Scope: what "MVP done" means (end of Phase 2 in `ROADMAP.md`, roughly week 5).
Anything not listed here is out of MVP scope.

## 1. MVP goal

Given a scenario with 2 concurrent HTTP requests against a local victim app, RaceHound
systematically explores statement interleavings through its proxy, detects an invariant
violation, and prints a minimal-enough failing timeline that can be replayed deterministically.

## 2. Users and environment

- User: a developer on their own machine (Himanshu).
- Database: PostgreSQL 18, native Windows service on `localhost:5432`, database `racehound`.
  (`docker-compose.yml` exists for other people and the Phase 5 demo only.)
- Proxy listens on `localhost:6433`.
- Victim apps: small Go HTTP servers in `victims/`, each with one deliberate race.

## 3. CLI (MVP)

```
racehound run <scenario.yaml> [--strategy exhaustive|random] [--max-runs N] [--seed S]
racehound replay <schedule.json> [--step]
racehound proxy [--listen localhost:6433] [--upstream localhost:5432]   # pass-through only, for debugging (D-012)
```

Exit codes: `0` no violation found, `1` violation found, `2` usage or configuration error,
`3` internal error.

## 4. Scenario file format (MVP)

```yaml
name: coupon-double-redeem
app:
  base_url: http://localhost:8081       # victim app, already running, DB pointed at :6433
database:
  admin_dsn: postgres://racehound:racehound@localhost:5432/racehound?sslmode=disable
  reset: victims/coupon/seed.sql        # executed on admin connection before every run
requests:                               # fired concurrently, each gets a tag A, B, ...
  - method: POST
    path: /redeem
    body: {code: DIWALI50, user_id: 1}
  - method: POST
    path: /redeem
    body: {code: DIWALI50, user_id: 2}
invariants:                             # each must return a single boolean true
  - name: coupon not over-redeemed
    sql: SELECT uses <= max_uses FROM coupons WHERE code = 'DIWALI50'
  - name: one redemption row per allowed use
    sql: SELECT count(*) <= 1 FROM redemptions WHERE code = 'DIWALI50'
```

## 5. Functional requirements

**Proxy**
- FR-1: Accept client connections on `localhost:6433` and open one upstream connection per client to Postgres.
- FR-2: Handle the startup phase transparently: reply `N` to `SSLRequest` (and to `GSSENCRequest`),
  forward the `StartupMessage` and all authentication messages unchanged, record the backend
  process ID from `BackendKeyData`.
- FR-3: After startup, parse message framing in both directions (1-byte type + 4-byte big-endian
  length that includes itself). Forward everything it does not need to inspect unchanged.
- FR-4: Support the simple query protocol (`Q` messages). One `Q` message = one schedulable step.
- FR-5: Recognise `ReadyForQuery` (`Z`) as "step finished" and read its status byte
  (`I` idle, `T` in transaction, `E` failed transaction).
- FR-6: Extended query protocol (`Parse/Bind/Execute/Sync`) is passed through unscheduled in the
  MVP and logged as a warning, so apps do not break.

**Request attribution**
- FR-7: The harness sends each request with header `X-RaceHound-Req: A|B|...`. Victim apps prefix
  every query with the SQL comment `/* rh:req=A */`. The proxy reads the tag from the comment.
- FR-8: Statements with no tag pass through immediately and are not scheduled (pool health checks etc.).

**Scheduler**
- FR-9: Each tagged statement is parked until the scheduler releases it.
- FR-10: A decision point is reached when every in-flight request is parked, blocked, or finished.
  A request that is neither (running app code) is waited for up to a quiet period (default 50 ms,
  configurable).
- FR-11: Lock-wait detection (MVP): if a released statement has not returned `ReadyForQuery`
  within a timeout (default 200 ms), mark that request blocked and continue scheduling others.
  When its `ReadyForQuery` arrives it becomes runnable again.
- FR-12: A run ends when all requests have received HTTP responses or a run timeout (default 10 s)
  fires. A run timeout is reported as a distinct outcome, not a violation.

**Exploration**
- FR-13: A schedule is the sequence of choices "which request's parked statement goes next".
- FR-14: `exhaustive`: depth-first search over the choice tree, replaying the prefix from a reset
  database each run, until the tree is exhausted or `--max-runs`.
- FR-15: `random`: at each decision point pick uniformly among runnable requests; seeded and
  reproducible with `--seed`.
- FR-16: Stop at the first violation by default; `--all` continues and reports every distinct one.

**Judging and reset**
- FR-17: Before each run, execute the scenario's `reset` SQL on the admin connection.
- FR-18: After each run, execute each invariant; any result other than a single `true` is a violation.
- FR-19: Record each request's HTTP status and body in the run result.

**Reporting and replay**
- FR-20: On violation, print a two-column (or N-column) timeline of statements per request, in
  executed order, with each statement's result summary (rows affected / first value / error).
- FR-21: Write the failing schedule to `.racehound/<scenario>-<run>.json` (scenario path, choices,
  seed, invariant results, timeline).
- FR-22: `replay` re-runs exactly that schedule and must reproduce the same violation.
- FR-23: `replay --step` pauses before each released statement until Enter is pressed.
- FR-24: Print summary stats: runs executed, runs/sec, resets/sec, time to first violation.

## 6. Victim apps (MVP benchmark suite)

Each in `victims/<name>/`: `main.go`, `seed.sql`, `scenario.yaml`, and a `README.md` stating the
bug, the expected bad interleaving, and the correct fix. Go + `pgx` with
`default_query_exec_mode=simple_protocol` and `sslmode=disable` in the DSN.

| Name | Race | Invariant |
|---|---|---|
| coupon | check-then-act on uses count | `uses <= max_uses` |
| inventory | two orders for the last item in stock | `stock >= 0` |
| seat | two bookings for one seat (no unique constraint) | one booking per seat |
| wallet | two withdrawals overdraw balance | `balance >= 0` |
| username | two signups with same username | unique usernames |
| transfer | lost update on read-modify-write in app code | total money conserved |
| approval | two approvers act on one pending request | one approval per request |
| counter | non-atomic increment (read, add in app, write) | final count = number of increments |

Each victim also has a fixed variant (flag `--fixed`) that RaceHound must report as clean.

## 7. Non-functional requirements

- NFR-1: Single static Go binary. Only external runtime dependency: Postgres.
- NFR-2: Deterministic: the same scenario, strategy and seed produce the same sequence of schedules.
- NFR-3: The proxy adds no meaningful overhead in pass-through mode (measure it).
- NFR-4: RaceHound's own code is `go test -race` clean.
- NFR-5: Clear errors for misconfiguration (proxy cannot reach Postgres, app not reachable,
  untagged requests, invariant SQL error).

## 8. MVP acceptance criteria

1. Kill test (Phase 1): a hand-written schedule reproduces the coupon double-redeem 10 times out of 10.
2. `racehound run` finds the race in all 8 victim apps, and reports none for all 8 fixed variants.
3. Every reported violation replays identically with `racehound replay`.
4. `docs/RESULTS.md` has a dated table with runs-to-first-violation, runs/sec and resets/sec for
   each victim, for both strategies.

## 9. Explicitly NOT in the MVP

Extended protocol scheduling, ORMs, Node/Python victims, `pg_locks`-based lock detection,
serial-equivalence oracle, PCT, partial-order reduction, shrinking, template-DB reset,
HTML report, CI integration, more than 3 concurrent requests. All are in `ROADMAP.md` phases 3-5.

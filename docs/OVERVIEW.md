# RaceHound: Overview

This is the plain-language "why and what" of the project. For exact requirements see
`SPEC.md`; for how it is built see `ARCHITECTURE.md`.

## What RaceHound is and is not

- **A testing tool, not part of the app.** Run from the terminal like `go test`. No website or dashboard.
- **The crash-test lab, not the seatbelt.** It finds races in the app's own rules (Postgres is
  assumed correct) and proves whether a fix holds. It never fixes the app: `FOR UPDATE`, unique
  constraints, conditional updates and SERIALIZABLE + retry are the developer's job.
- **Controlled, not blasted.** It fires 2-3 requests at once, holds every SQL statement at a red
  light in its proxy, and tries every order (DFS + replay), resetting the DB before and checking
  invariants after each. Result: "safe in all N orders" or "this exact order breaks rule X", replayable.
- **Needed even though locks exist**, because locks get misused in ways tests and review miss:
  (1) `FOR UPDATE` without `BEGIN`, (2) locking the wrong row, (3) nothing to lock yet (needs a
  unique constraint), (4) one endpoint locks, another doesn't, (5) the fix adds a deadlock. With a
  correct fix it sees the second request wait on the lock, lets the first finish, and confirms the
  rules hold in every order. That before/after proof is the product.
- **Input:** a scenario YAML with reset SQL, concurrent requests, and invariant SQL. Phase 3 adds an
  invariant-free mode: compare against one-after-another runs.

## The problem

A shop app has a coupon `DIWALI50` that can be used once. The redeem code does:

1. Read how many times the coupon has been used (0).
2. Check that 0 is less than the limit (1). It is, so continue.
3. Increase the used-count.
4. Record the redemption and give the discount.

If two requests run at the same moment, their steps interleave:

```
Request A: read used = 0
Request B: read used = 0        (A has not written yet)
Request A: 0 < 1, increment, give discount
Request B: 0 < 1, increment, give discount
```

The single-use coupon was used twice. This is a race condition: the outcome depends on timing.
The same pattern appears in seat booking, wallet withdrawals, inventory issue, duplicate
approvals and unique-username signups. Himanshu fixed exactly this class of bug by hand in a
production inventory system (row locks against double-issuance of stock).

## Why these bugs survive testing

- Normal tests send one request at a time, so the bad interleaving never happens.
- The bad interleaving needs precise timing. It shows up in production under load, rarely.
- When it happens it cannot be reproduced locally, because timing differs.
- The usual workaround is firing many requests at once and hoping. That is probabilistic,
  gives no guarantee about which orders were tried, and produces no minimal reproduction.
- Jepsen-style tools test databases themselves, not an application's business rules.

## What RaceHound does

```
App  ──►  RaceHound proxy  ──►  Postgres
          (controls order)
```

The app's `DATABASE_URL` points at RaceHound instead of Postgres. Every SQL statement passes
through it. RaceHound holds each statement and decides which one goes next, so it can:

1. Deliberately create a dangerous interleaving instead of hoping for it.
2. Explore many interleavings systematically, resetting the database between runs.
3. Check after each run whether something broke (an invariant query, or "this outcome could
   not happen if the requests had taken turns").
4. Report the shortest failing interleaving as a timeline, saved to a file and replayable.
5. Re-run after a fix to show the bug is gone.

## Example output (target)

```
RACE FOUND  (schedule 7 of 20, check failed: uses=2, max_uses=1)

  Request A (user 1)                 Request B (user 2)
  BEGIN
  SELECT uses → 0
                                     BEGIN
                                     SELECT uses → 0
  UPDATE uses = uses + 1
  COMMIT
                                     UPDATE uses = uses + 1
                                     COMMIT

  Replay: racehound replay .racehound/coupon-7.json
```

## How a developer uses it

1. Point the app at RaceHound (`localhost:6433`) instead of Postgres (`localhost:5432`).
2. Write a scenario file: seed data, which requests to fire concurrently, what must stay true.
3. `racehound run scenario.yaml` → terminal verdict, a replayable failure file, later an HTML report.
4. `racehound replay <file> --step` → re-run the exact failing order, pausing at each statement.

## The hard parts (what makes this a strong project)

- **Speaking the Postgres wire protocol** well enough that apps cannot tell the difference.
- **Attributing statements to requests**, since connection pools shuffle connections.
- **Not deadlocking itself**: if RaceHound holds A while B waits on a row lock that A's
  transaction holds, everything freezes. It must detect lock waits and move on.
- **Knowing when to decide**: a request may be running app code between statements. The
  scheduler must wait until every in-flight request is parked, blocked or finished.
- **Exploring smartly**: the number of interleavings explodes (2 requests × 10 statements each
  = 184,756 orders). Needs exhaustive search with pruning, randomized PCT, and skipping
  orders that cannot differ.
- **Judging without user-written rules**: compare every concurrent outcome with the outcomes
  of the serial orders.
- **Resetting fast**: thousands of runs need a clean database each time.
- **Shrinking** a failing order to the minimal one.

## Why this project, for Himanshu

- Extends his strongest real experience (concurrency correctness in production: row locks,
  optimistic concurrency, idempotent jobs) to a deeper layer.
- Moves below the web-app layer (wire protocol, scheduling, search) where his portfolio is thin.
- Produces its own numbers (bugs found, runs-to-detection, schedules pruned, resets/sec)
  without needing user adoption.
- Every hard part maps to a standard interview topic: isolation levels, deadlocks, search with
  pruning, protocol design, testing methodology.

## Interview talking points this should eventually support

- Why a proxy instead of instrumenting the app or the ORM.
- Which anomalies each isolation level allows (lost update, write skew, check-then-act).
- How lock-wait detection avoids self-deadlock.
- Why PCT finds shallow bugs faster than random.
- How partial-order reduction cuts the search space.
- Pessimistic vs optimistic locking, with real fixes verified by the tool.

## Resume bullets (templates only; fill with real numbers or do not use)

- Built a Postgres wire-protocol proxy that deterministically controls the interleaving of
  concurrent transactions to expose business-logic races; reproduced [N/N] seeded race bugs
  with minimal schedules in a median of [X] runs vs [Y] for concurrent request blasting.
- Implemented serial-equivalence checking and schedule pruning, cutting explored schedules by
  [X]% with no loss of detection on the benchmark suite.
- Found [N] previously unreported race conditions in open-source projects ([issue links]).

## Out of scope (deliberately)

- Web dashboards, logins, hosted service. RaceHound is a CLI plus a static HTML report.
- Databases other than Postgres.
- Testing anything other than apps and databases Himanshu runs locally.

## Ethics

Only run against apps and databases you run yourself. Report bugs found in open-source
projects privately to maintainers first.

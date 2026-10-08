# Interleave: Roadmap

About 12 weeks at 10-15 hours/week (alongside an internship until early January and
placement prep). Each phase has an exit test. Do not start a phase before the previous exit test passes.

## Phase 0: Setup (week 0)
- Install Go, git and PostgreSQL 18 natively. Postgres runs as a Windows
  service; put its `bin` on PATH so `psql` works. (Postgres + PATH done 2026-10-03.)
- Learn Go basics: Tour of Go through goroutines and channels.
- `go mod init`, repo skeleton, Makefile or task list of commands.
- First victim app `victims/coupon` talking directly to Postgres (port 5432), plus seed.sql.
- **Exit test:** firing 50 concurrent redeems at the coupon app directly sometimes over-redeems
  (proves the bug is real before Interleave exists).

## Phase 1: Proxy and kill test (weeks 1-2)
- `pgwire`: message framing, startup packet parsing, unit tests with captured bytes.
- `proxy`: pass-through mode. Coupon app works unchanged through `:6433`.
- Measure pass-through overhead (requests/sec direct vs via proxy).
- Tag extraction from `/* il:req=X */`; victim app adds tags from the header.
- First `sched` version: park steps and release them in a hard-coded order.
- **Exit test (kill test):** a hard-coded schedule reproduces the coupon double-redeem 10/10 times,
  and the opposite order never does. If this fails after 2 weeks, re-scope before continuing.

## Phase 2: MVP engine (weeks 3-5)
- `sched`: request states, decision points, quiet period, lock-wait timeout, run timeout.
- `explore`: exhaustive DFS with replay, seeded random.
- `oracle`: invariant queries.
- `scenario` parser, `harness`, `reset`, `runner` loop, terminal `report`, schedule.json, `replay`.
- Remaining 7 victim apps with fixed variants.
- Baseline benchmark numbers into `RESULTS.md`.
- **Exit test:** SPEC.md section 8 acceptance criteria all pass.

## Phase 3: Make it smart (weeks 6-8)
- Lock-wait detection via `pg_stat_activity` using backend PIDs; compare with timeout approach.
- Serial-equivalence oracle (no user-written invariants needed).
- PCT strategy; compare runs-to-detection against random and exhaustive.
- Partial-order reduction heuristic (independent steps commute); measure schedules saved.
- Shrinker (delta debugging) for failing schedules.
- Template-database fast reset; measure resets/sec before and after.
- **Exit test:** RESULTS.md shows before/after numbers for each optimisation, and the serial
  oracle finds all 8 victim bugs with invariants removed.

## Phase 4: Real-world apps (weeks 9-10)
- Extended protocol: schedule a Parse/Bind/Execute/Sync group as one step.
- Victims in Node (node-postgres) and Python (psycopg / SQLAlchemy) to prove language independence.
- Point Interleave at one open-source app with money/inventory logic, run locally.
- **Exit test:** at least one non-Go victim and one ORM-based app work end to end.

## Phase 5: Ship it (weeks 11-12)
- Static HTML report (single file). Keep to ~10% of effort.
- README with problem, demo GIF/video, architecture diagram, results table, design decisions.
- Write-up/blog post explaining the design (this is what referrals and off-campus readers see).
- Optional: GitHub Action that runs scenarios in CI.
- Report any real bugs found to maintainers privately; link issues once public.
- **Exit test:** a stranger can clone the repo, run one command, and see a race found and replayed.

## Rules for changing this roadmap
Scope changes are recorded in `DECISIONS.md`. If a phase overruns by
more than a week, cut scope from later phases rather than skipping exit tests.

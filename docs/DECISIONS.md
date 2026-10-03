# RaceHound: Design Decisions

A log of design choices: what we chose, what else we considered, and why.
This doubles as interview preparation: every entry is an answer to "why did you do it this way?"

Status values: **Proposed** (suggested during planning, not yet confirmed),
**Accepted**, **Superseded by D-xxx**. Initial entries were drafted while planning;
each one is reviewed, changed if needed, and marked Accepted.

Template for new entries (append at the bottom, keep each under ~12 lines):

```
## D-0xx: <title>
Status: Proposed | Accepted | Superseded by D-0yy      Date: YYYY-MM-DD
Context: <what problem forced a choice>
Decision: <what we chose>
Alternatives: <option> (why not), <option> (why not)
Consequences: <what this makes easy, what it makes hard, what to revisit later>
```

---

## D-001: Implement RaceHound in Go
Status: Accepted      Date: 2026-10-03
Context: Need a network proxy handling many connections plus a central scheduler.
Decision: Go.
Alternatives: TypeScript/Node (Himanshu knows it best, but proxies and fine-grained concurrency
are clumsier); Rust (strongest, but learning curve too steep for 12 weeks); C++ (familiar from
DSA, but networking boilerplate and memory safety cost time).
Consequences: Goroutines + channels map directly onto "each parked step waits for a release
signal". Static binary. Cost: 1-2 weeks learning Go. Fallback: if Go learning exceeds 2 weeks, switch to TypeScript.

## D-002: Intercept at the Postgres wire protocol (proxy), not inside the app
Status: Accepted      Date: 2026-10-03
Context: RaceHound must control the order of SQL statements from concurrent requests.
Decision: A TCP proxy speaking the Postgres protocol between app and database.
Alternatives: Instrumenting the DB driver or ORM (language-specific, one integration per stack);
instrumenting app code (invasive); database-side hooks or extensions (hard to control ordering,
needs DB superuser and C extensions).
Consequences: Works for any language with one config change (DATABASE_URL). Costs protocol
parsing work and makes request attribution harder (see D-004).

## D-003: Support the simple query protocol first
Status: Accepted      Date: 2026-10-03
Context: Postgres has a simple protocol (one Q message per statement) and an extended protocol
(Parse/Bind/Execute/Sync) used by most drivers for parameterised queries.
Decision: MVP schedules only Q messages; extended-protocol traffic passes through unscheduled,
and the proxy logs a warning when it sees it (avoids a silent "no race found" false negative).
Victim apps are configured to use the simple protocol.
Alternatives: Full extended protocol from day one (much more parsing before the kill test).
Consequences: Fast path to the kill test. Real apps need extended support (Phase 4).

## D-004: Attribute statements to requests with a SQL comment tag
Status: Accepted      Date: 2026-10-03
Context: Connection pools reuse connections across requests, so "connection" is not a stable
identity across runs; replaying a schedule needs stable identities.
Decision: Harness sends header X-RaceHound-Req; the app prefixes queries with /* rh:req=X */.
Untagged statements pass through unscheduled.
Alternatives: Schedule per connection (simplest, but pool assignment can differ between runs and
break replay); force one connection per request (changes app behaviour).
Consequences: Deterministic replay. Requires a small app-side change; later this can use the
sqlcommenter convention so real apps can adopt it with middleware.

## D-005: Reset the database by running seed SQL first; template databases later
Status: Accepted      Date: 2026-10-03
Context: Every run needs an identical starting state.
Decision: MVP runs the scenario's reset SQL (TRUNCATE ... RESTART IDENTITY + INSERT) on an admin
connection that bypasses the proxy. Every transaction from the previous run must be finished (or
its connection killed) before resetting, or TRUNCATE's exclusive lock waits forever.
Alternatives: CREATE DATABASE ... TEMPLATE per run (faster at scale, but pooled app connections
point at the old database, so the proxy would need to rewrite the database name and drop idle
connections); restarting Postgres (far too slow).
Consequences: Simple and fast enough for tiny victim tables. Measure resets/sec, then replace
with template clones in Phase 3 and report the speedup.

## D-006: Explore schedules as a choice tree with replay (stateless model checking)
Status: Accepted      Date: 2026-10-03
Context: The number of statements a request issues can depend on the interleaving (early returns),
so interleavings cannot be precomputed.
Decision: Make choices at runtime decision points; exhaustive mode is DFS over the choice tree,
replaying the prefix from a fresh reset each run.
Alternatives: Precompute all interleavings from a solo recording (breaks on branching code).
Consequences: Correct for branching apps; each run costs a reset, which makes reset speed matter.

## D-007: Detect lock waits with a timeout first, pg_stat_activity later
Status: Accepted      Date: 2026-10-03
Context: A released statement may block on a row lock held by another parked request; waiting for
it would deadlock the scheduler.
Decision: MVP marks a step blocked if ReadyForQuery has not arrived within a timeout
(default 200 ms, configurable via a CLI flag, not a hardcoded constant).
Alternatives: Query pg_blocking_pids / pg_locks for the backend PID (precise, more moving parts).
Consequences: Simple, but adds latency per blocked step and could misjudge a slow query.
Phase 3 replaces it and compares both, which is a good measured result.

## D-008: CLI tool and static report only, no web UI
Status: Accepted      Date: 2026-10-03
Context: The project should signal systems engineering, not frontend work.
Decision: Terminal output, replayable JSON schedules, later one static HTML report file.
Alternatives: Live web dashboard (high frontend effort, low engineering signal).
Consequences: Recruiters judge the engine, not the UI. Keep UI work to ~10% of time.

## D-009: Victim apps written in Go for the MVP
Status: Accepted      Date: 2026-10-03
Context: The benchmark suite needs small apps with known races.
Decision: Go + pgx (simple protocol) for MVP victims; Node and Python victims in Phase 4.
Alternatives: Node/Express first (Himanshu knows it, but adds a second toolchain to install now).
Consequences: Only Go and the native Postgres (D-010) needed to start. Language independence is
proven later. Adding pgx still needs its own dependency approval when the first victim is written.

## D-010: Native Postgres instead of Docker for local development
Status: Accepted      Date: 2026-10-03
Context: Development is on Windows. Docker Desktop needs WSL2/virtualisation, uses a lot of RAM,
and adds a VM network hop between proxy and database.
Decision: PostgreSQL 18.6 installed natively as a Windows service on localhost:5432 (role and
database `racehound`, role has CREATEDB). `docker-compose.yml` stays, for other people and the Phase 5 demo.
Everything runs natively on Windows (no WSL2); shell scripts run through Git Bash.
Alternatives: Docker Compose (disposable, version-pinned and identical for everyone, but heavier
on this laptop); WSL2 Postgres (still a VM, and localhost forwarding adds a hop).
Consequences: Lighter, always on, and timing measurements are free of Docker/VM networking noise.
Costs: the DB persists (reset relies on seed SQL, D-005); the server is shared machine-wide, so
tests and tools must only touch `racehound` and DBs RaceHound creates; the local version (18) differs from
compose (17), so bump compose to 18 before the demo. Postgres 18 brings protocol 3.2 (see ARCHITECTURE.md section 8).

## D-011: Plain Go module path `racehound` (no GitHub path yet)
Status: Accepted      Date: 2026-10-03
Context: `go mod init` needs a module path; the usual form is github.com/<user>/<repo>.
Decision: Use `racehound`. Imports look like `racehound/internal/proxy`.
Alternatives: github.com/<username>/racehound (ties the project to a GitHub account before
the project is published).
Consequences: Builds and tests work the same. When publishing, rename the module path in go.mod
and imports (one find-and-replace) so others can `go install` it.

## D-012: Proxy listens on localhost only; upstream must be loopback
Status: Proposed      Date: 2026-10-04
Context: SPEC section 3 showed `--listen :6433`. In Go, `:6433` binds every network interface, so
anyone on the same Wi-Fi could reach the local Postgres through the proxy, and Postgres would
see them as connecting from localhost (often trusted more in pg_hba.conf).
Decision: Default `--listen localhost:6433`. `proxy.New` refuses any upstream whose host is not
`localhost`, `127.0.0.1` or `::1` (port stays configurable so tests can use a fake server).
Alternatives: `:6433` as in the SPEC (reachable from the LAN); also forcing `--listen` to loopback
(stricter, but the default already covers the normal case; the Phase 5 Docker demo may need
other interfaces).
Consequences: Safe by default, and the "never a remote database" rule is enforced in code, not
just in docs. SPEC section 3 updated to match.

## D-013: pgwire reads from io.Reader without a context; cancel by closing the connection
Status: Proposed      Date: 2026-10-04
Context: the project's Go style rule says blocking I/O functions take a `context.Context`, but an
`io.Reader` cannot be interrupted by a context: a blocked `Read` ignores it.
Decision: `pgwire.ReadMessage(r)` / `ReadStartup(r)` take only an `io.Reader`. Cancellation lives
in the proxy: `context.AfterFunc(ctx, conn.Close)` closes the connection, which makes any blocked
read return an error at once. Messages keep `Raw` so the proxy forwards bytes without re-encoding.
Alternatives: a ctx parameter that is ignored (misleading); per-read deadlines from the ctx
(more code, same effect).
Consequences: `pgwire` stays pure and easy to unit-test with `bytes.Reader`; the proxy is the
single place that decides when connections close.

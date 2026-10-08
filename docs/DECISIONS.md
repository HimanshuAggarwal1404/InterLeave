# Interleave: Design Decisions

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

## D-001: Implement Interleave in Go
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
Context: Interleave must control the order of SQL statements from concurrent requests.
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
Decision: Harness sends header X-Interleave-Req; the app prefixes queries with /* il:req=X */.
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
database `interleave`, role has CREATEDB). `docker-compose.yml` stays, for other people and the Phase 5 demo.
Everything runs natively on Windows (no WSL2); shell scripts run through Git Bash.
Alternatives: Docker Compose (disposable, version-pinned and identical for everyone, but heavier
on this laptop); WSL2 Postgres (still a VM, and localhost forwarding adds a hop).
Consequences: Lighter, always on, and timing measurements are free of Docker/VM networking noise.
Costs: the DB persists (reset relies on seed SQL, D-005); the server is shared machine-wide, so
tests and tools must only touch `interleave` and DBs Interleave creates; the local version (18) differs from
compose (17), so bump compose to 18 before the demo. Postgres 18 brings protocol 3.2 (see ARCHITECTURE.md section 8).

## D-011: Plain Go module path `interleave` (no GitHub path yet)
Status: Accepted      Date: 2026-10-03
Context: `go mod init` needs a module path; the usual form is github.com/<user>/<repo>.
Decision: Use `interleave`. Imports look like `interleave/internal/proxy`.
Alternatives: github.com/<username>/interleave (ties the project to a GitHub account before
the project is published).
Consequences: Builds and tests work the same. When publishing, rename the module path in go.mod
and imports (one find-and-replace) so others can `go install` it.

## D-012: Proxy listens on localhost only; upstream must be loopback
Status: Accepted      Date: 2026-10-04
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

## D-014: Proxy batches writes: send messages that arrived together in one Write
Status: Accepted      Date: 2026-10-04
Context: `cmd/bench` showed the pass-through proxy costing 45-46% of throughput on the coupon app
(RESULTS.md). `proxy.forward` wrote each message on its own, so a Postgres reply sent in one go
(RowDescription, DataRow, CommandComplete, ReadyForQuery) left the proxy as 4 writes: 4 system
calls and usually 4 TCP packets.
Decision: `forward` writes into a 64 KiB `bufio.Writer` and flushes as soon as the read buffer
holds no further complete message. So it never waits for input while holding unsent bytes (no
hang when only half of the next message has arrived). Bytes are still forwarded unchanged.
Alternatives: flush only after ReadyForQuery (`Z`) (protocol-specific; would hold startup, COPY
and NOTICE traffic); flush only when the read buffer is empty (can hold a complete message while
waiting for the rest of a split one); keep one write per message (measured too slow).
Consequences: Measured in one alternating run (old vs new proxy, 4 x 10s): +20.5% req/s
(9414.3 → 11348.4, faster in 4/4 rounds); added p50 latency per request 0.98 ms → 0.53 ms
(~0.18 ms per round trip). Still -35.4% vs direct on this tiny-query workload; the rest is
probably the extra hop itself (not profiled; pprof in Phase 3). Tag extraction must keep this
rule when it starts parsing `Q` messages in the same loop.

## D-015: Request tag only at the very start of the query; tag is 1-64 of A-Z a-z 0-9 _ -
Status: Accepted      Date: 2026-10-04
Context: The proxy must find `/* il:req=X */` (D-004) in each Query. Where may it appear, and
what may X contain?
Decision: Only as the first thing in the query (leading whitespace and spaces inside the comment
allowed). X is 1-64 characters of `A-Z a-z 0-9 _ -`. A query that starts with our comment but
has a broken one (unclosed, bad characters) is logged and treated as untagged.
Alternatives: anywhere in the query (text inside a string value, e.g. a user name
`'/* il:req=A */'`, would pose as a tag unless we parse SQL quoting); start or end (also covers
sqlcommenter, which puts comments at the end; more code, not needed for our victims).
Consequences: Strict, simple and cannot be fooled by data. Apps using sqlcommenter (Phase 4) need
this revisited. Victim apps validate the X-Interleave-Req header with the same rule, because the
tag is pasted into SQL (otherwise SQL injection).

## D-016: Statements the app cannot tag pass through unscheduled (incl. pgx's ROLLBACK)
Status: Accepted      Date: 2026-10-04
Context: pgx sends BEGIN/COMMIT/ROLLBACK itself. `pgx.TxOptions{BeginQuery, CommitQuery}` lets
the app tag BEGIN and COMMIT, but ROLLBACK is always the plain text `rollback`. ORMs usually allow
none of this.
Decision: Keep FR-8 as written: untagged statements are forwarded at once and not scheduled.
Victims tag BEGIN/COMMIT via TxOptions; ROLLBACK (failure paths only) goes unscheduled.
Alternatives: inherit the tag inside a transaction (the proxy remembers a connection's last tag
while ReadyForQuery says `T`/`E`; works for ORMs, but more proxy state and edge cases now).
Consequences: Simplest rule; the kill test only needs tagged SELECT/UPDATE/INSERT/COMMIT. The
explorer cannot choose when a ROLLBACK runs. Revisit (tag inheritance) for ORM apps in Phase 4.

## D-017: Proxy↔sched interface: `OnQuery(ctx, tag, sql)` parks a query and returns its `done`
Status: Accepted      Date: 2026-10-04 (completion added 2026-10-09)
Context: The proxy knows each query's request tag (D-015). The scheduler must see each query, be
able to hold it, and learn when Postgres has finished it (ReadyForQuery `Z`, FR-5).
Decision: An optional function field `OnQuery func(ctx, tag, sql) (done func(status byte))`,
called on the app→Postgres goroutine for every `Q` before it is forwarded (after flushing held
bytes, D-014). Blocking in it parks the query. ctx is cancelled when the connection is torn down
or the proxy shuts down. The returned `done` (nil allowed) goes into a per-connection FIFO
channel; when the postgres→app goroutine has sent a `Z` to the app, it pops the oldest entry and
calls it with the status byte. A `Z` with an empty queue (end of startup, extended-protocol Sync)
belongs to no query and is skipped. Nil `OnQuery` means pure forwarding, no parsing cost.
Alternatives: a second callback `OnReady(tag, status)` (sched must match completions to steps by
tag; ambiguous if a request uses two connections; proxy needs a mutex-guarded "last tag" per
connection); a two-method interface (same pairing problem, more ceremony); a channel of query
events (cannot hold a query without an extra reply channel).
Consequences: Each step is paired with its own completion, so `sched` never maps tags to
connections. Every `Q` queues an entry, even a nil one, or pipelined replies would pair with the
wrong query. `done` runs on the connection's postgres→app goroutine, so it must not block
for long (send to sched with a `select` on ctx). If a connection dies mid-step, `done` is never
called; the run timeout covers that.

## D-018: Project renamed from RaceHound to Interleave
Status: Accepted      Date: 2026-10-08
Context: the project needed a new name.
Decision: Rename everywhere: Go module `interleave`, command `cmd/interleave`, header
`X-Interleave-Req`, request tag `/* il:req=X */` (was `rh:req`), env var `INTERLEAVE_TEST_DSN`,
results dir `.interleave/`, docker-compose names, Postgres role/password/database `interleave`, docs.
Alternatives: keep the Postgres role/database as `racehound` (nothing breaks, but one old name stays).
Consequences: the Postgres role and database are renamed by hand; until then
`TestRealPostgres` fails with an auth error. The project folder `D:\RaceHound` is renamed by hand.
Earlier entries and the session log were rewritten to use the new name.

## D-019: sched v1 interface, specified by tests written before the code
Status: Proposed      Date: 2026-10-09
Context: Phase 1 needs a first scheduler that parks tagged steps and releases them in a
hard-coded order (the kill test). Its behaviour should be pinned down before it is written.
Decision: `sched.New(order []string)`, where order lists request tags in release order (the
n-th `A` = A's n-th tagged statement). `(*Scheduler).OnQuery(ctx, tag, sql) func(status byte)`
has the proxy hook's shape (D-017), so `p.OnQuery = s.OnQuery`. `(*Scheduler).Run(ctx)
([]Step, error)` is the single goroutine that owns all state; `Step{Tag, SQL, Status}` is what
ran, in order. Rules: release exactly one step at a time, the next only after the previous
`done`; untagged queries and tags not in the order pass through (D-016); after `Run` returns
nothing blocks; a cancelled ctx (OnQuery's or Run's) un-parks waiting steps. The spec lives in
`internal/sched/sched_test.go` (7 tests, fake requests, no networking) and the Phase 1 exit test
in `victims/coupon/kill_test.go`; both carry a `sched` build tag until the package exists.
Alternatives: order as explicit (tag, statement index) pairs (more verbose, same power for v1);
steps addressed by SQL text (breaks when two statements are equal); no build tag (the normal
`go test ./...` would fail to compile until sched exists).
Consequences: v1 has no quiet period, lock-wait timeout or explorer: an order that makes a step
wait on a lock held by a parked step deadlocks until the run ctx times out (Phase 2 handles
that). Remove the build tags once the tests pass.

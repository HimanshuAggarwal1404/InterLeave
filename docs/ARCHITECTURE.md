# Interleave: Architecture

How the system is put together. Interfaces below are sketches to guide design, not final code.

## 1. Big picture

```
                 ┌──────────────────────── interleave run ────────────────────────┐
                 │                                                                │
 scenario.yaml ─►│ scenario ─► runner ─┬─► reset (admin conn) ─► Postgres          │
                 │                     ├─► harness: fire HTTP requests A, B ──────►│─► victim app
                 │                     │                                            │      │
                 │                     │   proxy (:6433) ◄──── SQL from app ◄───────┘      │
                 │                     │     │  parks tagged statements                    │
                 │                     │     ▼                                             │
                 │                     ├─► sched  ◄─── choices ─── explore                │
                 │                     │     │ releases one statement at a time            │
                 │                     │     ▼                                             │
                 │                     │   Postgres (:5432)                                │
                 │                     ├─► oracle: run invariants after the run            │
                 │                     └─► report: timeline, schedule.json                 │
                 └────────────────────────────────────────────────────────────────────┘
```

The proxy runs inside the `interleave run` process, so the scheduler and proxy share memory.

## 2. Package layout

TypeScript, run directly by Node.js (type stripping; `tsc --noEmit` only type-checks). Tests sit
next to the code as `*.test.ts`; specs written before their code are `*.spec.ts` (not in `npm test`).

```
src/cli/          CLI entry point: run, replay, proxy subcommands (flag parsing only); main.ts starts it
src/bench/        HTTP load generator for the pass-through overhead measurement (NFR-3)
src/pgwire/       Message framing: WireReader turns socket chunks into typed messages and startup
                  packets. No sockets of its own, no policy.
src/proxy/        Accepts client conns, dials upstream, forwards bytes, extracts request
                  tags, hands tagged Query messages to the scheduler, reports completions.
src/sched/        Parks steps, tracks request states, decides at decision points,
                  lock-wait timeout, quiet period. Owns the "what may run now" logic.
src/explore/      Strategies that produce choices: exhaustive DFS with replay,
                  random (seeded). Later: PCT, partial-order reduction.
src/oracle/       Runs invariants; later the serial-equivalence check.
src/harness/      Fires HTTP requests concurrently with X-Interleave-Req tags, collects responses.
src/reset/        Executes reset SQL on the admin connection. Later: template-DB clones.
src/scenario/     Parses and validates scenario.yaml.
src/report/       Terminal timeline, schedule.json writer/reader, later HTML report.
src/runner/       Orchestrates one run and the loop of runs: reset → start requests →
                  drive scheduler with explorer choices → judge → record.
src/testutil/     Helpers shared by tests (byte fixtures, cleanup that always runs).
victims/<name>/   Deliberately racy test apps (TypeScript + pg), each with app.ts, main.ts,
                  seed.sql, scenario.yaml, README.md.
scripts/          Small Node scripts (repeat.ts runs the concurrent suites many times).
```

Dependency direction: `cli → runner → {proxy, sched, explore, oracle, harness, reset, scenario,
report}`; `proxy → pgwire`; `sched` and `explore` depend on nothing project-specific beyond
shared types. Keep `sched` free of networking so it can be unit-tested with fake steps.

## 3. Core concepts (shared vocabulary)

- **Request**: one logical HTTP request in a scenario, tagged `A`, `B`, ...
- **Step**: one `Q` (simple query) message from a request, held at the proxy until released.
- **Request state**: `running` (in app code, no parked step) · `parked` (step waiting) ·
  `executing` (step released, awaiting `ReadyForQuery`) · `blocked` (executing past the lock-wait
  timeout) · `finished` (HTTP response received).
- **Decision point**: no request is `running` or `executing`; at least one is `parked`.
  (Blocked requests are not runnable.) If none are parked and none are executing, the run is
  stuck or done.
- **Choice**: at a decision point, which parked request's step to release.
- **Schedule**: the sequence of choices in a run. Replaying a schedule = making the same choices.
- **Run**: reset DB → fire requests → make choices until all finish → check invariants.

## 4. Lifecycle of one run

1. `reset` runs the scenario's reset SQL on the admin connection.
2. `harness` fires all requests concurrently, each with its tag header.
3. The app executes; each SQL statement reaches the `proxy` with `/* il:req=X */`.
4. `proxy` sends the step to `sched` and blocks that connection's forwarding until released.
5. `sched` waits for a decision point (quiet period handles requests still in app code), asks the
   explorer for a choice, releases that step. `proxy` forwards it upstream.
6. `proxy` sees `ReadyForQuery` from upstream for that connection, forwards it to the client,
   tells `sched` the step completed (with a result summary for the timeline).
7. If `ReadyForQuery` does not arrive within the lock-wait timeout, `sched` marks the request
   `blocked` and continues with other choices. When it arrives later, the request resumes.
8. When every request is `finished`, `oracle` runs the invariants on the admin connection.
9. `runner` records the result. On violation, `report` prints the timeline and writes the schedule.

## 5. Concurrency model (Node.js event loop)

Node runs all JavaScript on one thread. Waiting (for a socket, a timer, a release) never blocks
that thread: it is an `await` on a Promise, and other code runs in the meantime. So there are no
data races on shared variables, but every `await` is a point where other connections' code can
run: state read before an `await` may have changed after it.

- Each client connection is one async function (`handle`) with two async loops (`forward`
  pumps), one per direction. Whichever pump ends first closes both sockets.
- A parked step is a Promise that the scheduler has not resolved yet. While the proxy awaits it,
  that connection's client pump reads nothing more, so TCP backpressure holds the app.
- `sched` keeps all scheduling state in one object and is the only code that changes it (events
  in: step parked, step completed, request finished; decisions out: resolve step X's Promise).
  One thread means no locks are needed, but every decision must hold across awaits.
- Timers (quiet period, lock-wait timeout, run timeout) are owned by the scheduler and are always
  cleared; a forgotten timer keeps the process alive.
- Cancellation is an `AbortSignal` (one per proxy, one per connection, one per run). Everything that
  can wait takes one. Shutdown destroys every socket (`server.close()` alone leaves open
  connections running) and `serve()` settles only when every socket has closed. Tests verify that
  no socket or timer is left behind and that every test process exits by itself.
- Every socket and `pg.Pool` has an `'error'` listener: an unhandled `'error'` event stops the process.

## 6. Exhaustive exploration (DFS with replay)

The number of statements per request can change with the interleaving (an app may return early
when the coupon is exhausted), so schedules are not precomputed. Instead:

- Treat runs as paths in a tree. Each node is a decision point, each edge a choice.
- Run 1 picks the first runnable request at each node, recording the alternatives not taken.
- The next run replays the recorded prefix up to the deepest node with an untried alternative,
  takes that alternative, then continues picking first-runnable.
- Exhausted when no node has untried alternatives. This is stateless model checking.
- Replay validity check: if at a replayed node the expected choice is not runnable, the app is
  non-deterministic. Report this clearly instead of silently diverging.

## 7. Postgres wire protocol notes (MVP subset)

- Startup: first packet has no type byte: 4-byte length + 4-byte code. `80877103` = SSLRequest,
  `80877104` = GSSENCRequest (reply `N`, one byte, then read the real StartupMessage),
  `196608` = protocol 3.0 StartupMessage. `80877102` = CancelRequest (forward or ignore; log).
- After startup, every message: 1-byte type, 4-byte big-endian length including the length field.
- Backend messages we inspect: `R` auth (forward only), `K` BackendKeyData (record backend PID),
  `Z` ReadyForQuery (status byte `I`/`T`/`E`), `C` CommandComplete (tag like `UPDATE 1`),
  `E` ErrorResponse, `D` DataRow (for result summaries).
- Frontend messages we inspect: `Q` Query (string, NUL-terminated), `X` Terminate.
  `P`/`B`/`E`/`S` (extended protocol) pass through unscheduled in the MVP.
- Forward unknown messages unchanged. Never re-encode what you can forward byte-for-byte.
- Reference: PostgreSQL docs, "Frontend/Backend Protocol" chapter (message flow + message formats).

## 8. Known gotchas (add to this list as they are found)

- `pg` (node-postgres) uses the extended protocol (Parse/Bind/Execute) for any query with a values
  array (`$1`). Victims send plain text only, or statements bypass the scheduler; a test records
  the frontend message types on the wire to prove it.
- Node may resolve `localhost` to `::1` while a server listens on 127.0.0.1 only. Defaults and
  DSNs use `127.0.0.1` explicitly.
- Node sockets do not set TCP_NODELAY by default (Go does); the proxy sets it on both sides.
- Clients often try TLS first. Without the `N` reply to `SSLRequest`, connections hang.
- Connection pools open connections lazily and keep idle ones. Untagged health checks must pass
  through without scheduling or the run deadlocks.
- A released `UPDATE` can block on a row lock held by another parked request's open transaction.
  That is exactly the case the lock-wait timeout exists for.
- Reset SQL must not run while app transactions are open; the runner must wait for all requests
  to finish (or kill the run) before resetting.
- Local Postgres is **18.6** (native Windows service). Postgres 18 added **protocol 3.2**
  (StartupMessage code `196610`, vs `196608` for 3.0). In 3.2 the BackendKeyData secret key is
  variable length (up to 256 bytes) instead of a fixed 4, and CancelRequest carries the same
  longer key. Example: 3.0 `K` = `'K'` + len `12` + PID (4) + key (4); 3.2 `K` = `'K'` + len
  `8 + keylen` + PID (4) + key (keylen). So the proxy must parse every message by its length
  field and never assume fixed sizes: PID is the first 4 payload bytes, the key is the rest.
  Do not reject a 3.2 startup code; forward it and let the server negotiate.

## 9. Evolution after the MVP (see ROADMAP.md)

- Lock waits via `pg_stat_activity` / `pg_locks` using the recorded backend PIDs instead of timeouts.
- Serial-equivalence oracle: run the requests serially in every order, snapshot chosen tables,
  flag concurrent outcomes matching no serial outcome.
- PCT strategy (random priorities with d change points) and partial-order reduction
  (steps on disjoint tables/rows commute).
- Delta-debugging shrinker for failing schedules.
- Fast reset: template databases cloned per run, proxy rewrites the `database` startup parameter.
- Extended protocol scheduling (step = Parse..Sync group), ORM and non-TypeScript victims.
- Static HTML report, `interleave replay --step` polish, GitHub Action.


# Interleave

Interleave finds race conditions in web apps that use Postgres. It is a command-line testing tool
(like a test runner), not a website. It is written in TypeScript and runs on Node.js.

> **Status:** Phases 0-2 done: the MVP works. `interleave run` tries statement orders by itself,
> finds the race in all 8 victim apps within 3-4 runs, reports none in any of their fixed versions
> (every order checked), and every finding replays identically with `interleave replay` (numbers in
> `docs/RESULTS.md`). Phase 3 (making the search smarter) has started: lock waits are now detected by asking Postgres, which made exploring the fixed apps 3.7-5.5x faster. This README explains, in plain
> words, everything that exists so far and how to try each piece yourself. The full plan is in `docs/ROADMAP.md`; the detailed "why" is in
> `docs/OVERVIEW.md`; every test command is in `docs/TESTING.md`.

---

## The idea in one minute

A shop has a coupon `DIWALI50` that may be used **once**. The app's redeem code does:

1. Read how many times the coupon was used (0).
2. 0 is less than the limit (1), so carry on.
3. Add 1 to the used count, record the redemption.

Now two customers click "redeem" at the same moment. Both requests do step 1 before either does
step 3. Both read 0, both pass the check, both redeem. The single-use coupon was used twice.

This is a **race condition**: the result depends on the *order* in which two requests' steps
happen to run. It is hard to catch because almost every order is fine. Only an unlucky one
breaks, so normal tests pass and the bug shows up in production on a busy day.

**What Interleave will do about it.** It sits between the app and Postgres like a traffic
policeman. Every SQL statement from the concurrent requests is held at a red light. Interleave
then lets them through **in an order it chooses**, checks afterwards whether a rule was broken
(for example "uses must never exceed max_uses"), resets the database, and tries the next order.
In the end it says either "safe in all N orders" or "this exact order breaks the rule", and can
replay that order on demand. Instead of hoping to get unlucky, it tries every order on purpose.

---

## What is built so far

| # | Piece | What it is | Where |
|---|---|---|---|
| 1 | Toolchain | Node.js 24, TypeScript (type-checking only), Postgres 18.6 (Windows service), `psql` | `node --version`, `psql --version` |
| 2 | Coupon victim app | A tiny web app with the coupon bug above, written deliberately | `victims/coupon/` |
| 3 | Phase 0 exit test | A test proving the bug is real, by hammering the app with 50 requests at once | `victims/coupon/app.test.ts` |
| 4 | `pgwire` | Code that cuts the raw bytes between an app and Postgres into individual messages | `src/pgwire/` |
| 5 | Pass-through proxy | Sits between the app and Postgres and forwards every message unchanged | `src/proxy/` |
| 6 | `interleave proxy` command | Runs the proxy from the terminal on port 6433 | `src/cli/` |
| 7 | Overhead benchmark | Measures requests/sec and latency with and without the proxy (results in `docs/RESULTS.md`) | `src/bench/` |
| 8 | Request tags | Each statement says which HTTP request it belongs to; the proxy reads it | `src/proxy/tag.ts`, `victims/coupon/` |
| 8b | Step done | The proxy tells its hook when each statement has finished, and how (`ReadyForQuery` status) | `src/proxy/proxy.ts`, `src/pgwire/ready.ts` |
| 8c | `--fixed` coupon | The correct version of the app (`SELECT ... FOR UPDATE`), proven by blasting | `victims/coupon/` |
| 8d | Scheduler v1 + kill test | Holds tagged statements and releases them in a given order; the Phase 1 exit test | `src/sched/`, `victims/coupon/kill.test.ts` |
| 9 | Scheduler v2 | Decides by itself *when* to release: request states, decision points, quiet period, lock-wait detection | `src/sched/run.ts` |
| 10 | Explorers | Choose *which* request goes next: every order (exhaustive DFS), seeded random, replay | `src/explore/` |
| 11 | Scenarios, harness, reset, oracle | The YAML test description; fire the tagged HTTP requests; reset the data; check the rules | `src/scenario/`, `src/harness/`, `src/reset/`, `src/oracle/` |
| 12 | Runner, report, `run` and `replay` | The loop of runs, the timeline, the saved schedule, the two commands | `src/runner/`, `src/report/`, `src/cli/` |
| 13 | Seven more victims + a shared kit | inventory, seat, wallet, username, transfer, approval, counter, each with a `--fixed` | `victims/` |
| 14 | Acceptance test | Interleave against all 8 victims, buggy and fixed | `victims/acceptance.e2e.ts` |
| 15 | Project docs | Spec, architecture, roadmap, decisions, overview, results, testing | `docs/` |

The project was first written in Go and moved to TypeScript (decision D-020): same design, same
behaviour, same tests. The Go version is kept in git under the tag `go-final`.

Sections 2-7 below are the foundations (Phases 0-1): the **test subject**, **proof the bug is
real**, the **proxy**, and a first **scheduler** that releases statements in an order you give it.
Section 8 is the engine (Phase 2) that *chooses* orders by itself, checks the rules after every
run, and reports the order that breaks them.

### 2. The coupon victim app (`victims/coupon/`)

A "victim" is a small app that is buggy on purpose, so Interleave has something to find. Its files:

- `app.ts`: a web server handler with one endpoint, `POST /redeem`, taking
  `{"code": "DIWALI50", "user_id": 1}`. Inside a transaction it runs:
  ```sql
  SELECT uses, max_uses FROM coupons WHERE code = 'DIWALI50';   -- the check
  -- (in TypeScript) if uses >= max_uses → reply "coupon already used up"
  UPDATE coupons SET uses = uses + 1 WHERE code = 'DIWALI50';   -- the act
  INSERT INTO redemptions (code, user_id) VALUES ('DIWALI50', 1);
  COMMIT;
  ```
- `main.ts`: reads the flags and starts the HTTP server on `127.0.0.1:8081`.
- `seed.sql`: creates two tables (`coupons`, `redemptions`) if they do not exist and resets them
  to one unused, single-use coupon. Run it before every attempt to start clean.
- `README.md`: the bug, the bad order step by step, and the fix.

**Why wrapping it in a transaction (`BEGIN ... COMMIT`) does not save it.** By default Postgres
uses the **READ COMMITTED** isolation level, where a plain `SELECT` takes no lock. Request B can
read the row while request A is still between its check and its update. Both see `uses = 0`.

**The fix**, behind the `--fixed` flag (the default stays buggy, because the bug is the point):
`SELECT ... FOR UPDATE` locks the row, so B has to wait until A commits, and then sees
`uses = 1`. Later, Interleave must show the buggy version breaks in some order and the fixed
version holds in **every** order. That before/after proof is the product.
`FixedNeverOverRedeems` blasts the fixed version the same way `RaceIsReal` blasts the
buggy one (20 rounds of 50 requests): it must never over-redeem, and exactly one request wins.

**How it connects to Postgres:** by default to port **6433** on `127.0.0.1`, where Interleave's
proxy listens (start it with `interleave proxy`, see "Try it yourself" Step 6). Pass `--dsn` with
port **5432** to skip the proxy and talk to Postgres directly. The app sends every statement as
plain text, never with separate parameter values; see "Simple vs extended protocol" in the
glossary for why. Values are still inserted safely: text through node-postgres's `escapeLiteral`,
numbers only after checking they are whole numbers.

### 3. The Phase 0 exit test (`RaceIsReal`)

Each phase of the roadmap ends with an "exit test" that must pass before moving on. Phase 0's
question: *is the bug real, without any Interleave magic?*

What the test does, round by round (up to 20 rounds):
1. Run `seed.sql`, so the coupon is fresh (`uses = 0`, `max_uses = 1`).
2. Fire 50 redeem requests at once. One loop starts all 50 before any of them gets to run
   (JavaScript runs one piece of code at a time), so they hit the app together.
3. Wait for all of them, then ask Postgres: is `uses` greater than `max_uses`?
4. If yes, the bug happened: log it and pass. If 20 rounds go by without it, fail.

Typical output:
```
✔ RaceIsReal (348.3217ms)
ℹ round 2: single-use coupon redeemed 7 times (7 redemption rows)
```
It usually triggers in round 2. In round 1 the app is still opening database connections, which
spreads the requests out in time.

This "blast it and hope" approach is exactly what Interleave replaces: it is luck-based, and when
it fails it tells you nothing about *which* order caused the bug.

### 4. `pgwire`: reading the Postgres language (`src/pgwire/`)

To hold SQL statements at a red light, the proxy must understand the bytes flowing between the
app and Postgres. Those bytes follow the **Postgres wire protocol**, a fixed binary format. `pgwire`
is the part that turns a raw stream of bytes into separate messages. It only *reads and labels*
messages; deciding what to do with them is the proxy's job.

**The problem it solves.** A network connection (TCP) is one long stream of bytes with no gaps
between messages. Node hands the proxy that stream in **chunks** of whatever size arrived: half a
message, or three and a half. Postgres solves this by putting a **length** in front of every
message, so the reader always knows where one ends and the next begins.

**Shape 1: a regular message** (almost everything):
```
 'Z'          00 00 00 05        'I'
 type (1 B)   length (4 B)       body
              counts itself + body, not the type byte
```
That is `ReadyForQuery` with body `I` = "idle, ready for the next query". Other types:
`Q` = a SQL query from the app, `C` = "command done" (e.g. `UPDATE 1`), `X` = "goodbye", `R` = an
authentication step, `K` = the server's process ID.

**Shape 2: a startup packet** (only the very first packet from the app). It has no type byte,
just a length and a 4-byte **code** saying what kind of packet it is:

| Code | Meaning |
|---|---|
| 80877103 | SSLRequest: "can we encrypt?" (we will answer `N`, no) |
| 80877104 | GSSENCRequest: "can we use Kerberos encryption?" (also `N`) |
| 80877102 | CancelRequest: "stop the query running on connection X" |
| 196608 | StartupMessage, protocol 3.0, followed by `user`, `database`, ... settings |
| 196610 | StartupMessage, protocol 3.2 (new in Postgres 18) |

**What the code gives you:** a `WireReader`, one per connection, wrapped around the socket:
- `await reader.readMessage()` → `{ type, body, raw }`, or `null` when the connection ended cleanly
- `await reader.readStartup()` → `{ code, params, raw }`

It keeps the chunks it has received but not yet handed out, and returns only whole messages.
`raw` is every byte exactly as received. The proxy forwards `raw` unchanged instead of rebuilding
the message, which is simpler and cannot introduce encoding bugs. `body` is not a copy: it is a
view into the same memory as `raw`.

**Safety checks.** A length that is impossible (smaller than the header) or absurd (over 1 GiB
for messages, over 10,000 bytes for startup packets, the same limits Postgres uses) is rejected
as soon as the length arrives, before waiting for or keeping any of the body. If the connection
ends cleanly between messages you get `null` ("they hung up"). If it ends in the middle of a
message you get an `UnexpectedEOFError` ("the line dropped").

**Where the test bytes came from.** The tests use real bytes captured on this machine. A
throwaway program pretended to be a server, `psql` connected to it, and it recorded what
`psql` sent (an SSLRequest, then a StartupMessage with `user=interleave database=interleave
application_name=psql`). It also recorded Postgres 18.6's first reply: an `R` message saying
"prove your password with SCRAM-SHA-256". The other test messages are built by hand from the
official protocol docs, with a comment on each explaining every byte. Every case is also fed to
the reader **one byte per chunk**, the worst way a socket could deliver it.

**The Postgres 18 gotcha.** In protocol 3.2 the `K` message (server process ID + secret key) can
have a key up to 256 bytes instead of always 4. Code that assumes "`K` is always 12 bytes" breaks.
`pgwire` never assumes sizes; it always trusts the length field, and a test checks this.

### 5. The pass-through proxy (`src/proxy/`, `src/cli/`)

The proxy is a middleman. The app thinks it is talking to Postgres, but it is talking to
Interleave on port 6433, which passes everything on to the real Postgres on 5432 and passes the
answers back:

```
coupon app ──► interleave proxy (127.0.0.1:6433) ──► Postgres (127.0.0.1:5432)
           ◄──                                  ◄──
```

Right now it changes nothing; it is "pass-through". That is the point of this step: before
Interleave holds statements back, it must prove it can sit in the middle without breaking
anything. Later, the "hold at the red light" logic goes inside it.

**What happens when an app connects:**
1. **Accept.** Each new connection gets its own async function, so many apps or pool
   connections are served at once. (Node runs one thing at a time, but while one connection
   waits for bytes, the others run.)
2. **Startup.** Read the first packet with the connection's `WireReader`.
   - If it asks "can we encrypt?" (SSLRequest), the proxy itself answers `N` (no), and the app
     carries on unencrypted. Encryption would turn the messages into unreadable noise, and
     the proxy must read them. Everything stays on your own machine anyway.
   - If it is a CancelRequest ("stop that slow query"), forward it to Postgres and hang up.
   - Otherwise it is the real StartupMessage: connect to Postgres and forward it unchanged.
3. **Pump.** Two loops: one copies app → Postgres, the other Postgres → app, one message at a
   time. The login (SCRAM password exchange) flows through untouched. The proxy never sees or
   needs the password.
4. **Send in batches.** Postgres sends a whole reply (columns, rows, "done", "ready") in one
   go. The proxy reads those messages one by one, but collects them and sends them on together
   in one write, as soon as nothing more is already waiting to be read. The first (Go) version
   sent each message separately, which made the app about 45% slower (see `docs/RESULTS.md`). It
   never holds bytes back while waiting for more input, so batching cannot cause a hang. If the
   other side reads slowly (the write reports a full buffer), the pump waits until it drains
   instead of piling up data in memory.

**Who closes what (the tricky part).** A pump waiting for bytes from one side cannot notice that
the other direction has finished. So the rule is: *whichever pump stops first closes both
connections*. Closing a connection ends the other pump's wait at once, so it stops too. Shutdown
(Ctrl+C) uses the same trick: stop accepting new connections, close every app connection (closing
the listening server alone would leave open connections running), then wait until every socket
is really closed. If `serve()` has returned, nothing is left running. The tests check this,
including that no socket or timer is left open.

**Safety, built into the code:**
- It only forwards to **this machine** (`localhost`, `127.0.0.1` or `::1`). Any other upstream
  address is refused with an error, so Interleave cannot be pointed at someone's real database.
- It listens on **`127.0.0.1:6433`** by default, not on every network interface, which would let
  anyone on your Wi-Fi reach your Postgres through the proxy. Postgres would also see those
  connections as coming from localhost. The address is written as `127.0.0.1` rather than
  `localhost` on purpose: Node may turn `localhost` into the IPv6 address `::1`.

**How it is tested** (`src/proxy/proxy.test.ts`, 15 tests; `forward.test.ts`, 5 tests):
- With a **fake Postgres** (a socket the test controls): SSL gets `N`; the startup, the
  server's replies, a query and the goodbye are each forwarded byte for byte; if Postgres hangs
  up, the app's connection closes; a CancelRequest is forwarded; an unreachable Postgres
  closes the app's connection instead of hanging; shutdown closes open connections and leaves no
  socket or timer behind; an app that drops its connection while a query is held releases that
  query.
- With your **real Postgres 18**: node-postgres connects through the proxy, logs in with SCRAM,
  runs 20 queries at once over 5 connections and does a transaction. Then `psql` connects through
  it with `sslmode=prefer`, which sends the SSL request first and must get the `N`.
- `forward` on its own: a burst of messages leaves in one write; a complete message is sent at
  once even when only half of the next one has arrived; anything held back is sent before the
  `onQuery` hook sees the next message (the hook may wait once the scheduler exists); and a slow
  reader makes it wait instead of buffering without limit.
- All of it passes 20 times in a row (`npm run test:repeat`).

**The command** (`src/cli/interleave.ts`): `interleave proxy [--listen ...] [--upstream ...] [--verbose]`
(`--verbose` logs every query with its request tag, see Step 7). Exit code 2 means you gave it
bad input (unknown command, remote upstream, port in use), 3 an internal error. Ctrl+C triggers
the clean shutdown described above.

### 6. Request tags (`src/proxy/tag.ts`, `victims/coupon/`)

To control the order of statements, Interleave must know **which HTTP request each statement
belongs to**. The connection does not tell us: a pool hands the same connection to different
requests (D-004). So the requests carry a name:

1. Interleave sends each request with a header, e.g. `X-Interleave-Req: A`.
2. The app puts that name in a SQL comment at the start of every statement:
   `/* il:req=A */ SELECT uses, max_uses FROM coupons ...`. Postgres ignores comments.
3. The proxy reads the comment (`requestTag`) and reports `(tag, sql)` through its `onQuery`
   hook. The scheduler will plug in there to hold statements: while the Promise the hook returns
   is still pending, the statement waits.
4. When Postgres finishes a statement it sends `ReadyForQuery` (`Z`) with a status byte: `I`
   idle, `T` inside a transaction, `E` inside a failed one. The hook may return a `done`
   function for the statement; the proxy calls it with that status once the `Z` has reached
   the app, so the scheduler knows the step is over (D-017). Postgres answers a connection's
   statements in order, so a per-connection queue pairs each `Z` with its statement.

Rules (D-015, D-016, D-021):
- The tag counts **only at the very start** of the query, so text inside a value (say a user
  name `'/* il:req=A */'`) cannot pretend to be a tag.
- A tag is 1-64 of `A-Z a-z 0-9 _ -`. The app **rejects any other header with 400**: the header
  is pasted into SQL, so `A */ DROP TABLE coupons; --` would otherwise be SQL injection.
- The coupon app tags every statement it sends, `BEGIN`, `COMMIT` and `ROLLBACK` included.
  Statements an app cannot tag pass through unscheduled.

**How it is tested:** `QueryString` (pgwire, 7 cases) and `RequestTag` (17 cases) for
the parsing; `OnQueryReportsTags` checks the hook sees each query, before it is forwarded;
`OnQueryAsyncHookParks` checks a query waits while the hook's Promise is pending;
`QueriesCarryRequestTag` runs the coupon app through a real proxy and checks exactly which
statements carry which tag; `StatementsUseSimpleProtocol` records every message the app sends on
the wire. For "step done": `ReadyStatus` (7 cases), `ForwardReportsReadyAfterSendingIt`,
`DoneGetsEachQuerysReadyStatus` (including two statements sent before either reply) and
`ShutdownReleasesParkedQuery`.


### 7. The scheduler and the kill test (`src/sched/`, `victims/coupon/kill.test.ts`)

The scheduler is the "traffic policeman". You give it an order of request names, for example
`A, A, B, B, A, A, A, B, B, B`, meaning "A's 1st statement, A's 2nd, then B's 1st, B's 2nd, then A's
3rd, ...". It plugs into the proxy's `onQuery` hook:

- When a tagged statement arrives, the hook returns a Promise that stays **pending**: the
  statement is held, and the proxy forwards nothing more from that connection.
- When it is that statement's turn **and** the previous statement has finished (its
  `ReadyForQuery` came back), the scheduler resolves the Promise: the statement goes to Postgres.
- Exactly one statement runs at a time. Statements without a tag, from requests the order does
  not name, or beyond a request's turns in the order, are not held at all.
- `run()` resolves with a trace of what ran, with each statement's status. If the run is aborted
  (a timeout, Ctrl+C), every held statement is let go so nothing hangs.

All its state lives in one object, and one private method makes every release decision; it is
called whenever a statement arrives, one finishes, or the run starts. Its rules are pinned down by
`src/sched/sched.test.ts` (8 tests), written before the code.

**The kill test** (Phase 1 exit) wires everything real together: the coupon app, the proxy,
Postgres and the scheduler. Requests A and B are fired at the same moment; only the order differs:

| Order | What must happen | Result |
|---|---|---|
| `A A B B A A A B B B` (both SELECTs before either UPDATE) | both redeem: `uses = 2`, both 200 | 10 / 10 runs |
| `A A A A A B B B` (all of A, then B) | A redeems, B gets 409, `uses = 1` | 10 / 10 runs |

The same bug that blasting found only by luck now happens **every time**, on demand.

### 8. The engine: `interleave run` and `interleave replay` (Phase 2)

The kill test needed someone to *know* the bad order. The engine finds it. One **run** is:

1. **Reset** the database (`reset: seed.sql` in the scenario, on a separate admin connection).
2. **Fire** the scenario's requests at the app at the same moment, tagged `A`, `B`
   (`src/harness/`).
3. **Schedule** their statements with `RunScheduler` (`src/sched/run.ts`). Each request is
   *running* (in app code), *parked* (a statement waits at the red light), *executing* (released,
   Postgres is working on it), *blocked* (waiting for a row lock the other request holds:
   Interleave asks Postgres every 10 ms with `pg_blocking_pids`) or *finished* (its HTTP response
   arrived). When nothing is
   running or executing and something is parked, that is a **decision point**: the explorer picks
   which parked request goes next. A request still in app code is waited for only 50 ms (the
   **quiet period**; 1 s before its first statement, while its app may still be connecting), so
   an app that never sends another statement cannot stall the run.
4. **Judge**: run each invariant (`src/oracle/`). Any answer other than a single `true` is a
   violation. A Postgres deadlock error (`40P01`) also counts as a finding. And if the scenario
   has a `serial:` section, the **serial oracle** compares the result (the listed columns plus each
   request's HTTP status) with what running the requests *one at a time* gives, in every order:
   a result no one-at-a-time order can produce is a race, no hand-written rule needed. It finds
   all 8 victims' races with their invariants deleted.

The **explorer** (`src/explore/`) decides what each run tries. `exhaustive` (the default) walks the
tree of all choices depth-first: run 1 always picks the first runnable request, and each next run
replays the previous choices up to the deepest point with an untried alternative, then takes it.
When no alternative is left, *every* order has been checked. `random` picks at random from a seed,
so `--seed 7` always explores the same orders. `pct` (Phase 3) gives each request a random
priority and preempts the running one at `--depth` - 1 random points: it is built for races that
need one request stopped at exactly the right place while the other runs a long stretch (the
`ledger` benchmark victim; `npm run compare` measures all three strategies on it). The runner (`src/runner/`) loops until a violation
(or every distinct one, with `--all`), `--max-runs` (default 1000), or the tree is exhausted.

A finding prints as a timeline, one column per request, each statement with what it did, and the
choices are saved to `.interleave/<scenario>-<run>.json`:

```
FOUND in run 3: invariant "stock never negative", "one order for the one widget" broke

Request A: POST /order {...}                           Request B: POST /order {...}
BEGIN
SELECT stock FROM products WHERE name = 'widget' → 1
UPDATE products SET stock = stock - 1 WHE… → UPDATE 1
INSERT INTO orders (product, qty, user_… → INSERT 0 1
                                                       BEGIN
                                                       SELECT stock FROM products WHERE name = 'widget' → 1
COMMIT
                                                       UPDATE products SET stock = stock - 1 WHE… → UPDATE 1
                                                       INSERT INTO orders (product, qty, user_… → INSERT 0 1
                                                       COMMIT
```

`interleave replay <file>` makes exactly those choices again and must reproduce the violation;
`--step` waits for Enter before each statement, so you can watch the race in slow motion.

**The eight victims** (`victims/<name>/`, each with a README showing its bad order and why the fix works):

| Victim | Port | The race | The fix (`--fixed`) |
|---|---|---|---|
| coupon | 8081 | both read "0 uses" before either writes | `SELECT ... FOR UPDATE` (row lock) |
| inventory | 8082 | two orders for the last item | check and act in one `UPDATE ... WHERE stock >= qty` |
| seat | 8083 | two bookings for one seat | lock the seat row before counting bookings |
| wallet | 8084 | two withdrawals overdraw the balance | `SERIALIZABLE` isolation + retry on error 40001 |
| username | 8085 | two signups with the same name | advisory lock on the name (no row exists yet to lock) |
| transfer | 8086 | lost update: balances written from stale reads | lock both rows, always in id order (no deadlock) |
| approval | 8087 | two managers approve one request | optimistic locking: `UPDATE ... WHERE version = <read>` |
| counter | 8088 | read, add 1 in the app, write back | `SET n = n + 1` in the database |
| ledger (benchmark) | 8089 | a deposit read before the long month-end close, written after it: the fee is lost | `SET balance = balance + amount`; used to compare strategies (`npm run compare`) |

They share `victims/common/`: one HTTP endpoint helper (tag check, JSON body, 400/404/405/500) and
`transaction()`, which tags `BEGIN`/`COMMIT`/`ROLLBACK` and rolls back on every path that does not
succeed. `npm run test:acceptance` checks all eight, buggy and fixed.

---

## Try it yourself

Run everything from **Git Bash** in the repo folder. The first time, install the project's
packages (they go into `node_modules/` inside the project only):
```bash
npm install
```

### Step 1: check the tools
```bash
node --version        # v24.13.0 (22.18 or newer works)
psql --version        # psql (PostgreSQL) 18.6
```

### Step 2: run every test
```bash
npx tsc --noEmit      # type-check: prints nothing when everything is fine
npm test
```
Expected: about 225 tests, `ℹ fail 0` (two summaries: the victim tests run separately, one file
at a time, because they share the database), in a few seconds. The tests that need Postgres skip
themselves if it is not running.

Node has no race detector like Go's `-race`; instead the concurrent parts are run 20 times in a
row (see `docs/TESTING.md` for why):
```bash
npm run test:repeat
```

### Step 3: watch the coupon bug happen
```bash
node --test --test-name-pattern=RaceIsReal victims/coupon/app.test.ts
```
Look for `single-use coupon redeemed N times`, where N is bigger than 1. Run it a few times: N
changes, because it depends on timing.

Now the same blast against the fixed version, which must hold every time:
```bash
node --test --test-name-pattern=FixedNeverOverRedeems victims/coupon/app.test.ts
```

### Step 4: use the app by hand
Terminal 1, reset the data and start the app talking straight to Postgres:
```bash
psql "postgresql://interleave:interleave@127.0.0.1:5432/interleave" -f victims/coupon/seed.sql
node victims/coupon/main.ts --dsn "postgres://interleave:interleave@127.0.0.1:5432/interleave?sslmode=disable"
```
(Two `NOTICE: relation ... already exists, skipping` lines are harmless.) Wait for
`coupon victim listening on http://127.0.0.1:8081`.

Terminal 2, redeem twice:
```bash
curl -X POST http://127.0.0.1:8081/redeem -d '{"code":"DIWALI50","user_id":1}'   # → redeemed
curl -X POST http://127.0.0.1:8081/redeem -d '{"code":"DIWALI50","user_id":2}'   # → coupon already used up
```
Look inside the database:
```bash
psql "postgresql://interleave:interleave@127.0.0.1:5432/interleave" -c "SELECT * FROM coupons" -c "SELECT * FROM redemptions"
```
You should see `uses = 1` and one redemption row. One at a time, the app is correct.

Now try to break it by hand. Reset, then fire 20 requests "at once":
```bash
psql "postgresql://interleave:interleave@127.0.0.1:5432/interleave" -f victims/coupon/seed.sql
for i in $(seq 1 20); do curl -s -X POST http://127.0.0.1:8081/redeem -d "{\"code\":\"DIWALI50\",\"user_id\":$i}" & done; wait
```
**You will almost certainly see only one `redeemed`.** On Windows each `curl` is a separate
program that takes milliseconds to start, so the requests arrive one after another and never
overlap. When we tried it: 1 redeemed, 19 rejected. The bug is there, but this test is too slow
to hit it. The test in Step 3 gets the overlap only because it starts its 50 requests from one
program within microseconds. This is the core problem Interleave solves: it will not depend on
luck or speed.

Stop the app with `Ctrl+C` in terminal 1.

### Step 5: poke at `pgwire`
```bash
node --test src/pgwire/*.test.ts
```
Every case is listed by name, e.g. `ReadyForQuery idle, one byte per chunk`.

A good exercise: open `src/pgwire/message.test.ts`, find the `ReadyForQuery idle` case,
and change its length byte `0x05` to `0x06`. Run the tests again. The message now claims one
more byte than it has, so `readMessage` reports an `UnexpectedEOFError` and the test fails. Undo
with:
```bash
git checkout src/pgwire/message.test.ts
```

### Step 6: run the app through the proxy
Terminal 1, start the proxy:
```bash
npm run proxy
```
It prints `interleave proxy: 127.0.0.1:6433 -> 127.0.0.1:5432 (Ctrl+C to stop)`.

Terminal 2, reset the data and start the coupon app **without** `--dsn`, so it uses its default,
port 6433, the proxy:
```bash
psql "postgresql://interleave:interleave@127.0.0.1:5432/interleave" -f victims/coupon/seed.sql
npm run coupon
```

Terminal 3, the same two redeems as Step 4:
```bash
curl -X POST http://127.0.0.1:8081/redeem -d '{"code":"DIWALI50","user_id":1}'   # → redeemed
curl -X POST http://127.0.0.1:8081/redeem -d '{"code":"DIWALI50","user_id":2}'   # → coupon already used up
```
The app behaves exactly as before. That is the goal: the proxy is invisible.

`psql` can go through the proxy too (port 6433). psql asks for SSL first, so this also shows the
`N` reply working with a real client:
```bash
psql "postgresql://interleave:interleave@127.0.0.1:6433/interleave" -c "SELECT code, uses, max_uses FROM coupons"
```

And the 50-request race test, through the proxy instead of direct:
```bash
INTERLEAVE_TEST_DSN="postgres://interleave:interleave@127.0.0.1:6433/interleave?sslmode=disable" \
  node --test --test-name-pattern=RaceIsReal victims/coupon/app.test.ts
```
It still finds the double-redeem: a pass-through proxy neither hides nor causes the bug. When
we ran it: `round 2: single-use coupon redeemed 8 times`.

Finally, press **Ctrl+C** in terminal 1. The proxy prints `interleave proxy: stopped`. Since the
coupon app's connections are cut, its next request will fail until the proxy is back.

### Step 7: watch the request tags
Same three terminals as Step 6, but start the proxy with `--verbose`, which logs every query:
```bash
npm run proxy -- --verbose
```
Reset and start the app (terminal 2) as in Step 6, then send two named requests (terminal 3):
```bash
curl -X POST http://127.0.0.1:8081/redeem -H "X-Interleave-Req: A" -d '{"code":"DIWALI50","user_id":1}'
curl -X POST http://127.0.0.1:8081/redeem -H "X-Interleave-Req: B" -d '{"code":"DIWALI50","user_id":2}'
```
Terminal 1 shows each statement with its request (when we ran it):
```
query [-] SELECT 1
query [A] /* il:req=A */ BEGIN
query [A] /* il:req=A */ SELECT uses, max_uses FROM coupons WHERE code = 'DIWALI50'
query [A] /* il:req=A */ UPDATE coupons SET uses = uses + 1 WHERE code = 'DIWALI50'
query [A] /* il:req=A */ INSERT INTO redemptions (code, user_id) VALUES ('DIWALI50', 1)
query [A] /* il:req=A */ COMMIT
query [B] /* il:req=B */ BEGIN
query [B] /* il:req=B */ SELECT uses, max_uses FROM coupons WHERE code = 'DIWALI50'
query [B] /* il:req=B */ ROLLBACK
```
`[-]` means untagged: the `SELECT 1` is the app checking at startup that it can reach Postgres.
A bad header is refused before any SQL runs:
```bash
curl -X POST http://127.0.0.1:8081/redeem -H "X-Interleave-Req: A */ DROP TABLE coupons; --" -d '{"code":"DIWALI50","user_id":3}'
# → invalid X-Interleave-Req header
```


### Step 8: force the race on purpose
```bash
npm run test:sched
```
This runs the scheduler's tests and the kill test against your Postgres: `✔ KillTest` means the bad
order double-redeemed in 10 of 10 runs and the serial order never did.

### Step 9: let Interleave find a race by itself
Two terminals. The app's database is Interleave's own proxy, which `interleave run` starts (the app
only warns until it is up):
```bash
node victims/inventory/main.ts                              # terminal 1
npm run interleave -- run victims/inventory/scenario.yaml   # terminal 2
```
Expected: `FOUND in run 3`, the timeline above, and exit code 1. Then watch it again step by step:
```bash
npm run interleave -- replay .interleave/inventory-last-item-3.json --step
```
Restart terminal 1 with `--fixed` and run again: `No violation. Complete: all 24 orders checked`, exit
code 0. Every victim works the same way (`victims/<name>/main.ts`, `victims/<name>/scenario.yaml`).
To run all of them, buggy and fixed, in one go (about a minute):
```bash
npm run test:acceptance
```

---

## Two different kinds of "race": do not mix them up

| | Races in Interleave's own code | Races Interleave finds |
|---|---|---|
| What | Interleave's async code running in an unlucky order (Node runs one thing at a time, but at every `await` other code can run) | Two **HTTP requests** whose SQL statements interleave badly in the **database** |
| How we check | Tests for each ordering rule, the concurrent suites run 20 times in a row, and checks that nothing is left open or hangs (`docs/TESTING.md`) | A proxy holds SQL statements and releases them in chosen orders |
| Would it catch the coupon bug? | **No.** The app's code has no shared variable; the shared thing is a database row | **Yes**, that is its whole job |

This is a likely interview question.

---

## Words you will hear

- **Race condition**: the result depends on the timing or order of concurrent operations.
- **Check-then-act**: read a value, decide, then write, as separate steps. Anything can change
  between the check and the act. The coupon bug is one of these.
- **Transaction** (`BEGIN ... COMMIT`): a group of statements that succeed or fail together.
  On its own it does *not* stop other transactions from reading the same rows.
- **READ COMMITTED**: Postgres's default isolation level. Each statement sees data committed
  before it started. Plain `SELECT`s take no locks.
- **Row lock / `FOR UPDATE`**: makes other transactions wait before touching that row until you
  commit. The standard fix for check-then-act.
- **Invariant**: a rule that must always hold, e.g. `uses <= max_uses`. Interleave checks
  invariants after every run.
- **Interleaving / schedule**: one specific order in which the statements of concurrent requests
  ran. Interleave tries many of them.
- **Proxy**: a program in the middle. The app connects to it as if it were Postgres; it passes
  traffic on to the real Postgres and can inspect or delay it.
- **Wire protocol**: the exact byte format two programs use to talk over the network.
- **Simple vs extended protocol**: two ways to send SQL to Postgres. Simple sends a whole query
  in one `Q` message, which is easy to hold and release. Extended splits it into several
  messages (Parse/Bind/Execute) and is what node-postgres uses when a query has separate values
  (`$1`). The MVP only schedules simple-protocol queries, so victim apps send plain text.
- **Connection pool**: the app keeps a few database connections open and reuses them, instead
  of connecting per request.
- **Request tag**: the name (A, B, ...) Interleave gives each HTTP request. The app copies it
  into a SQL comment, `/* il:req=A */`, so the proxy knows which request a statement is from.
- **SQL injection**: user input pasted into SQL that changes what the SQL does. Why the app
  checks the tag header before using it, and escapes the coupon code.
- **Promise / async / await**: a Promise is a value that arrives later; `await` pauses one
  function until it arrives, while the rest of the program keeps running. A statement "held at
  the red light" is simply a Promise that has not been resolved yet.
- **AbortSignal**: a "please stop" flag that can be handed to anything that waits; used for
  shutdown and for giving up on a connection that went away.
- **Backpressure**: when the receiver is slower than the sender, the sender waits instead of
  piling up data in memory.
- **Decision point**: the moment the scheduler may release a statement: nothing is running or
  executing, and at least one statement is waiting.
- **Exhaustive (DFS) exploration**: trying every possible order by walking the tree of choices
  depth-first, replaying the start of the previous order each time. Also called stateless model
  checking.
- **Lost update**: two transactions read a value, both compute a new one, and the second write
  silently overwrites the first (the counter and transfer victims).
- **Optimistic vs pessimistic locking**: pessimistic locks the row before working on it
  (`FOR UPDATE`); optimistic does not lock, but only writes if the row is unchanged (a version
  column) and fails otherwise.
- **SERIALIZABLE**: the strictest isolation level. Postgres guarantees the result equals some
  one-at-a-time order of the transactions, and aborts one with error `40001` when it cannot; the
  app must retry.
- **Advisory lock**: a lock on a number the app chooses, with no table behind it; useful when
  there is no row to lock yet.
- **Deadlock**: two transactions each wait for a lock the other holds. Postgres detects it and
  aborts one (`40P01`).

---

## Folder map

```
README.md                 this file
package.json, package-lock.json   the project's npm scripts and its few packages (pg, typescript, types)
tsconfig.json             TypeScript settings (type-checking only; Node runs the .ts files itself)
docs/                     SPEC, ARCHITECTURE, ROADMAP, DECISIONS, OVERVIEW, RESULTS, TESTING
src/cli/                  the interleave command: run, replay, proxy
src/pgwire/               message framing + startup packets
src/proxy/                pass-through proxy, request tags, step done
src/sched/                the schedulers: run.ts decides at decision points; sched.ts is the fixed-order v1
src/explore/              which request goes next: exhaustive DFS, seeded random, replay
src/scenario/             reads and checks scenario.yaml
src/harness/              fires the tagged HTTP requests
src/reset/                resets the database before each run
src/oracle/               checks the invariants after each run
src/runner/               the loop of runs (Engine), findings, summary
src/report/               the timeline, the summary, schedule files
src/bench/                load generator for the proxy overhead measurement
src/testutil/             small helpers shared by the tests
victims/coupon/           the buggy coupon app (+ --fixed), seed data, README, exit + kill tests,
                          interleave run/replay end to end
victims/<name>/           seven more victims: inventory, seat, wallet, username, transfer, approval, counter
victims/common/           the kit the victims share (endpoint, transaction, SQL literals, startVictim)
victims/acceptance.e2e.ts Interleave against all 8 victims, buggy and fixed
scripts/repeat.ts         runs the concurrent test suites 20 times in a row
docker-compose.yml        only for other people / the final demo; not used on this machine
```

---

## What comes next (Phase 3)

Phase 2 is done: Interleave finds all 8 races and clears all 8 fixes. Phase 3 (`docs/ROADMAP.md`)
makes it smarter: knowing for sure when a statement waits for a lock (instead of a timeout),
checking results against every one-at-a-time order (so no hand-written invariant is needed),
smarter search (PCT, skipping orders that cannot differ), shrinking findings, and faster resets.

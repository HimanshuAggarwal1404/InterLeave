
# RaceHound

RaceHound finds race conditions in web apps that use Postgres. It is a command-line testing tool
(like `go test`), not a website.

> **Status:** Phase 0 done. Phase 1 in progress: `pgwire` and the pass-through proxy are done. This README explains, in plain words, everything that
> exists so far and how to try each piece yourself. It is updated as each piece lands.
> The full plan is in `docs/ROADMAP.md`; the detailed "why" is in `docs/OVERVIEW.md`.

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

**What RaceHound will do about it.** It sits between the app and Postgres like a traffic
policeman. Every SQL statement from the concurrent requests is held at a red light. RaceHound
then lets them through **in an order it chooses**, checks afterwards whether a rule was broken
(for example "uses must never exceed max_uses"), resets the database, and tries the next order.
In the end it says either "safe in all N orders" or "this exact order breaks the rule", and can
replay that order on demand. Instead of hoping to get unlucky, it tries every order on purpose.

---

## What is built so far

| # | Piece | What it is | Where |
|---|---|---|---|
| 1 | Toolchain | Go 1.27.1, Postgres 18.6 (Windows service), `psql`, 64-bit gcc (needed by `go test -race`) | `go version`, `psql --version` |
| 2 | Coupon victim app | A tiny web app with the coupon bug above, written deliberately | `victims/coupon/` |
| 3 | Phase 0 exit test | A test proving the bug is real, by hammering the app with 50 requests at once | `victims/coupon/main_test.go` |
| 4 | `pgwire` (Phase 1, step 1) | Code that cuts the raw bytes between an app and Postgres into individual messages | `internal/pgwire/` |
| 5 | Pass-through proxy (Phase 1, step 2) | Sits between the app and Postgres and forwards every message unchanged | `internal/proxy/` |
| 6 | `racehound proxy` command | Runs the proxy from the terminal on port 6433 | `cmd/racehound/` |
| 7 | Overhead benchmark | Measures requests/sec with and without the proxy (results in `docs/RESULTS.md`) | `cmd/bench/` |
| 8 | Request tags (Phase 1, step 3) | Each statement says which HTTP request it belongs to; the proxy reads it | `internal/proxy/tag.go`, `victims/coupon/` |
| 9 | Project docs | Spec, architecture, roadmap, decisions, overview, results | `docs/` |

The order-trying engine (scheduler, explorer, invariant checker) does not exist yet. So far we
have the **test subject** (the buggy app), **proof the bug is real**, and the **proxy** that
the engine will be built into. The proxy already knows which request each statement belongs to,
but it still passes everything straight through, without holding anything back.

### 2. The coupon victim app (`victims/coupon/`)

A "victim" is a small app that is buggy on purpose, so RaceHound has something to find. Its files:

- `main.go`: a web server with one endpoint, `POST /redeem`, taking `{"code": "DIWALI50", "user_id": 1}`.
  Inside a transaction it runs:
  ```sql
  SELECT uses, max_uses FROM coupons WHERE code = 'DIWALI50';   -- the check
  -- (in Go) if uses >= max_uses → reply "coupon already used up"
  UPDATE coupons SET uses = uses + 1 WHERE code = 'DIWALI50';   -- the act
  INSERT INTO redemptions (code, user_id) VALUES ('DIWALI50', 1);
  COMMIT;
  ```
- `seed.sql`: creates two tables (`coupons`, `redemptions`) if they do not exist and resets them
  to one unused, single-use coupon. Run it before every attempt to start clean.
- `README.md`: the bug, the bad order step by step, and the fix.

**Why wrapping it in a transaction (`BEGIN ... COMMIT`) does not save it.** By default Postgres
uses the **READ COMMITTED** isolation level, where a plain `SELECT` takes no lock. Request B can
read the row while request A is still between its check and its update. Both see `uses = 0`.

**The fix** (not applied, because the bug is the point): `SELECT ... FOR UPDATE` locks the row,
so B has to wait until A commits, and then sees `uses = 1`. Later, RaceHound must show the buggy
version breaks in some order and the fixed version holds in **every** order. That before/after
proof is the product.

**How it connects to Postgres:** by default to port **6433**, where RaceHound's proxy listens
(start it with `racehound proxy`, see "Try it yourself" Step 6). Pass `--dsn` with port
**5432** to skip the proxy and talk to Postgres directly. The connection string also has `default_query_exec_mode=simple_protocol`; see
"Simple vs extended protocol" in the glossary for why.

### 3. The Phase 0 exit test (`TestRaceIsReal`)

Each phase of the roadmap ends with an "exit test" that must pass before moving on. Phase 0's
question: *is the bug real, without any RaceHound magic?*

What the test does, round by round (up to 20 rounds):
1. Run `seed.sql`, so the coupon is fresh (`uses = 0`, `max_uses = 1`).
2. Start 50 goroutines (lightweight Go threads), one per fake customer. Each waits at a
   "starting gate" (a channel). Closing the channel releases all 50 at the same instant, which
   maximises the chance of overlap.
3. Wait for all of them (a `sync.WaitGroup`), then ask Postgres: is `uses` greater than `max_uses`?
4. If yes, the bug happened: log it and pass. If 20 rounds go by without it, fail.

Typical output:
```
main_test.go:40: round 2: single-use coupon redeemed 4 times (4 redemption rows)
--- PASS: TestRaceIsReal
```
It usually triggers in round 2. In round 1 the app is still opening database connections, which
spreads the requests out in time.

This "blast it and hope" approach is exactly what RaceHound replaces: it is luck-based, and when
it fails it tells you nothing about *which* order caused the bug.

### 4. `pgwire`: reading the Postgres language (`internal/pgwire/`)

To hold SQL statements at a red light, the proxy must understand the bytes flowing between the
app and Postgres. Those bytes follow the **Postgres wire protocol**, a fixed binary format. `pgwire`
is the part that turns a raw stream of bytes into separate messages. It only *reads and labels*
messages; deciding what to do with them is the proxy's job (next step).

**The problem it solves.** A network connection (TCP) is one long stream of bytes with no gaps
between messages. If the app sends two messages, they may arrive glued together or split in
odd places. Postgres solves this by putting a **length** in front of every message, so the
reader always knows where one ends and the next begins.

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

**What the code gives you:**
- `ReadMessage(r)` → `Message{Type, Body, Raw}`
- `ReadStartup(r)` → `Startup{Code, Params, Raw}`

`Raw` is every byte exactly as received. The proxy will forward `Raw` unchanged instead of
rebuilding the message, which is simpler and cannot introduce encoding bugs. `Body` is not a
copy: it points into the same memory as `Raw` (a Go "sub-slice").

**Safety checks.** A length that is impossible (smaller than the header) or absurd (over 1 GiB
for messages, over 10,000 bytes for startup packets, the same limits Postgres uses) is rejected
*before* any memory is allocated. If the connection ends cleanly between messages you get
`io.EOF` ("they hung up"). If it ends in the middle of a message you get
`io.ErrUnexpectedEOF` ("the line dropped").

**Where the test bytes came from.** The tests use real bytes captured on this machine. A
throwaway program pretended to be a server, `psql` connected to it, and it recorded what
`psql` sent (an SSLRequest, then a StartupMessage with `user=racehound database=racehound
application_name=psql`). It also recorded Postgres 18.6's first reply: an `R` message saying
"prove your password with SCRAM-SHA-256". The other test messages are built by hand from the
official protocol docs, with a comment on each explaining every byte.

**The Postgres 18 gotcha.** In protocol 3.2 the `K` message (server process ID + secret key) can
have a key up to 256 bytes instead of always 4. Code that assumes "`K` is always 12 bytes" breaks.
`pgwire` never assumes sizes; it always trusts the length field, and a test checks this.

### 5. The pass-through proxy (`internal/proxy/`, `cmd/racehound/`)

The proxy is a middleman. The app thinks it is talking to Postgres, but it is talking to
RaceHound on port 6433, which passes everything on to the real Postgres on 5432 and passes the
answers back:

```
coupon app ──► racehound proxy (localhost:6433) ──► Postgres (localhost:5432)
           ◄──                                  ◄──
```

Right now it changes nothing; it is "pass-through". That is the point of this step: before
RaceHound holds statements back, it must prove it can sit in the middle without breaking
anything. Later, the "hold at the red light" logic goes inside it.

**What happens when an app connects:**
1. **Accept.** Each new connection gets its own goroutine, so many apps or pool connections
   can be served at once.
2. **Startup.** Read the first packet with `pgwire.ReadStartup`.
   - If it asks "can we encrypt?" (SSLRequest), the proxy itself answers `N` (no), and the app
     carries on unencrypted. Encryption would turn the messages into unreadable noise, and
     the proxy must read them. Everything stays on your own machine anyway.
   - If it is a CancelRequest ("stop that slow query"), forward it to Postgres and hang up.
   - Otherwise it is the real StartupMessage: connect to Postgres and forward it unchanged.
3. **Pump.** Two goroutines: one copies app → Postgres, the other Postgres → app, one
   message at a time with `pgwire.ReadMessage`. The login (SCRAM password exchange) flows
   through untouched. The proxy never sees or needs the password.
4. **Send in batches.** Postgres sends a whole reply (columns, rows, "done", "ready") in one
   go. The proxy reads those messages one by one, but collects them and sends them on together
   as soon as nothing more is already waiting to be read. The first version sent each message
   separately, which made the app about 45% slower (see `docs/RESULTS.md`). It never holds
   bytes back while waiting for more input, so batching cannot cause a hang.

**Who closes what (the tricky part).** A goroutine waiting in `Read` cannot notice that the
other direction has finished. So the rule is: *whichever pump stops first closes both
connections*. Closing a connection makes the other pump's waiting `Read` fail at once, so it
stops too. Shutdown (Ctrl+C) uses the same trick: close the listener (no new connections) and
every app connection, then wait until every goroutine has exited. If `Serve` returns, nothing
is left running. The tests check this.

**Safety, built into the code:**
- It only forwards to **this machine** (`localhost`, `127.0.0.1` or `::1`). Any other upstream
  address is refused with an error, so RaceHound cannot be pointed at someone's real database.
- It listens on **`localhost:6433`** by default, not `:6433`. In Go, `:6433` means "every
  network interface", which would let anyone on your Wi-Fi reach your Postgres through the
  proxy. Postgres would also see those connections as coming from localhost.

**How it is tested** (`internal/proxy/proxy_test.go`, 8 tests; `forward_test.go`, 3 tests):
- With a **fake Postgres** (a socket the test controls): SSL gets `N`; the startup, the
  server's replies, a query and the goodbye are each forwarded byte for byte; if Postgres hangs
  up, the app's connection closes; a CancelRequest is forwarded; an unreachable Postgres
  closes the app's connection instead of hanging; shutdown closes open connections.
- With your **real Postgres 18**: pgx connects through the proxy, logs in with SCRAM, runs 20
  queries at once over 5 connections and does a transaction. It does this twice: once with
  `sslmode=disable` and once with `sslmode=prefer` (which sends the SSL request).
- `forward` on its own: a burst of messages leaves in one write, and a complete message is
  sent at once even when only half of the next one has arrived, and anything held back is sent
  before the `OnQuery` hook sees the next message (the hook may block once the scheduler exists).
- All of it passes 20 times in a row under `go test -race`.

**The command** (`cmd/racehound/main.go`): `racehound proxy [--listen ...] [--upstream ...] [--verbose]`
(`--verbose` logs every query with its request tag, see Step 7).
Exit code 2 means you gave it bad input (unknown command, remote upstream, port in use), 3 an
internal error. `signal.NotifyContext` turns Ctrl+C into a cancelled `context`, which triggers
the clean shutdown described above.

### 6. Request tags (`internal/proxy/tag.go`, `victims/coupon/`)

To control the order of statements, RaceHound must know **which HTTP request each statement
belongs to**. The connection does not tell us: a pool hands the same connection to different
requests (D-004). So the requests carry a name:

1. RaceHound sends each request with a header, e.g. `X-RaceHound-Req: A`.
2. The app puts that name in a SQL comment at the start of every statement:
   `/* rh:req=A */ SELECT uses, max_uses FROM coupons ...`. Postgres ignores comments.
3. The proxy reads the comment (`requestTag`) and reports `(tag, sql)` through its `OnQuery`
   hook. The scheduler will plug in there to hold statements.

Rules (D-015, D-016):
- The tag counts **only at the very start** of the query, so text inside a value (say a user
  name `'/* rh:req=A */'`) cannot pretend to be a tag.
- A tag is 1-64 of `A-Z a-z 0-9 _ -`. The app **rejects any other header with 400**: the header
  is pasted into SQL, so `A */ DROP TABLE coupons; --` would otherwise be SQL injection.
- The coupon app tags `BEGIN` and `COMMIT` too, through `pgx.TxOptions`. pgx's `rollback` cannot
  be tagged, so it passes through unscheduled, like pgx's `-- ping` health checks.

**How it is tested:** `TestQueryString` (pgwire, 7 cases) and `TestRequestTag` (17 cases) for
the parsing; `TestOnQueryReportsTags` checks the hook sees each query, before it is forwarded;
`TestQueriesCarryRequestTag` runs the coupon app through a real proxy and checks exactly which
statements carry which tag.

---

## Try it yourself

Run everything from **Git Bash** in the repo folder.

### Step 1: check the tools
```bash
go version            # go1.27.1 windows/amd64
psql --version        # psql (PostgreSQL) 18.6
gcc -dumpmachine      # x86_64-w64-mingw32   (64-bit, needed for -race)
```

### Step 2: run every test
```bash
go test ./...
```
Expected: `ok` lines for `cmd/racehound`, `internal/pgwire`, `internal/proxy` and `victims/coupon`.

Now the same with Go's race detector switched on:
```bash
go test -race ./...
```
Same `ok` lines, a bit slower.

### Step 3: watch the coupon bug happen
```bash
go test ./victims/coupon -run TestRaceIsReal -v -count=1
```
`-v` shows the log lines and `-count=1` stops Go from reusing a cached result. Look for
`single-use coupon redeemed N times`, where N is bigger than 1. Run it a few times: N changes,
because it depends on timing.

### Step 4: use the app by hand
Terminal 1, reset the data and start the app talking straight to Postgres:
```bash
psql "postgresql://racehound:racehound@localhost:5432/racehound" -f victims/coupon/seed.sql
go run ./victims/coupon --dsn "postgres://racehound:racehound@localhost:5432/racehound?sslmode=disable&default_query_exec_mode=simple_protocol"
```
(Two `NOTICE: relation ... already exists, skipping` lines are harmless.) Wait for
`coupon victim listening on http://localhost:8081`.

Terminal 2, redeem twice:
```bash
curl -X POST localhost:8081/redeem -d '{"code":"DIWALI50","user_id":1}'   # → redeemed
curl -X POST localhost:8081/redeem -d '{"code":"DIWALI50","user_id":2}'   # → coupon already used up
```
Look inside the database:
```bash
psql "postgresql://racehound:racehound@localhost:5432/racehound" -c "SELECT * FROM coupons" -c "SELECT * FROM redemptions"
```
You should see `uses = 1` and one redemption row. One at a time, the app is correct.

Now try to break it by hand. Reset, then fire 20 requests "at once":
```bash
psql "postgresql://racehound:racehound@localhost:5432/racehound" -f victims/coupon/seed.sql
for i in $(seq 1 20); do curl -s -X POST localhost:8081/redeem -d "{\"code\":\"DIWALI50\",\"user_id\":$i}" & done; wait
```
**You will almost certainly see only one `redeemed`.** On Windows each `curl` is a separate
program that takes milliseconds to start, so the requests arrive one after another and never
overlap. When we tried it: 1 redeemed, 19 rejected. The bug is there, but this test is too slow
to hit it. The Go test in Step 3 gets the overlap only because its 50 goroutines start within
microseconds. This is the core problem RaceHound solves: it will not depend on luck or speed.

Stop the app with `Ctrl+C` in terminal 1.

### Step 5: poke at `pgwire`
```bash
go test ./internal/pgwire -v
```
Every case is listed by name, e.g. `TestReadMessage/AuthenticationSASL_(captured)`.

A good exercise: open `internal/pgwire/message_test.go`, find the `ReadyForQuery idle` case,
and change its length byte `0x05` to `0x06`. Run the tests again. The message now claims one
more byte than it has, so `ReadMessage` reports `unexpected EOF` and the test fails. Undo with:
```bash
git checkout internal/pgwire/message_test.go
```
(Once this is committed. Until then, just change `0x06` back to `0x05`.)

### Step 6: run the app through the proxy
Terminal 1, start the proxy:
```bash
go run ./cmd/racehound proxy
```
It prints `racehound proxy: 127.0.0.1:6433 -> localhost:5432 (Ctrl+C to stop)`.

Terminal 2, reset the data and start the coupon app **without** `--dsn`, so it uses its default,
port 6433, the proxy:
```bash
psql "postgresql://racehound:racehound@localhost:5432/racehound" -f victims/coupon/seed.sql
go run ./victims/coupon
```

Terminal 3, the same two redeems as Step 4:
```bash
curl -X POST localhost:8081/redeem -d '{"code":"DIWALI50","user_id":1}'   # → redeemed
curl -X POST localhost:8081/redeem -d '{"code":"DIWALI50","user_id":2}'   # → coupon already used up
```
The app behaves exactly as before. That is the goal: the proxy is invisible.

`psql` can go through the proxy too (port 6433). psql asks for SSL first, so this also shows the
`N` reply working with a real client:
```bash
psql "postgresql://racehound:racehound@localhost:6433/racehound" -c "SELECT code, uses, max_uses FROM coupons"
```

And the 50-request race test, through the proxy instead of direct:
```bash
RACEHOUND_TEST_DSN="postgres://racehound:racehound@localhost:6433/racehound?sslmode=disable&default_query_exec_mode=simple_protocol" \
  go test ./victims/coupon -run TestRaceIsReal -v -count=1
```
It still finds the double-redeem: a pass-through proxy neither hides nor causes the bug. When
we ran it: `round 2: single-use coupon redeemed 4 times`.

Finally, press **Ctrl+C** in terminal 1. The proxy prints `racehound proxy: stopped`. Since the
coupon app's connections are cut, its next request will fail until the proxy is back.

### Step 7: watch the request tags
Same three terminals as Step 6, but start the proxy with `--verbose`, which logs every query:
```bash
go run ./cmd/racehound proxy --verbose
```
Reset and start the app (terminal 2) as in Step 6, then send two named requests (terminal 3):
```bash
curl -X POST localhost:8081/redeem -H "X-RaceHound-Req: A" -d '{"code":"DIWALI50","user_id":1}'
curl -X POST localhost:8081/redeem -H "X-RaceHound-Req: B" -d '{"code":"DIWALI50","user_id":2}'
```
Terminal 1 shows each statement with its request (when we ran it):
```
query [A] /* rh:req=A */ BEGIN
query [A] /* rh:req=A */ SELECT uses, max_uses FROM coupons WHERE code = 'DIWALI50'
query [A] /* rh:req=A */ UPDATE coupons SET uses = uses + 1 WHERE code = 'DIWALI50'
query [A] /* rh:req=A */ INSERT INTO redemptions (code, user_id) VALUES ( 'DIWALI50' , '1' )
query [A] /* rh:req=A */ COMMIT
query [B] /* rh:req=B */ BEGIN
query [B] /* rh:req=B */ SELECT uses, max_uses FROM coupons WHERE code = 'DIWALI50'
query [-] rollback
```
`[-]` means untagged. You will also see `query [-] -- ping` now and then: the connection pool
checking its connections. A bad header is refused before any SQL runs:
```bash
curl -X POST localhost:8081/redeem -H "X-RaceHound-Req: A */ DROP TABLE coupons; --" -d '{"code":"DIWALI50","user_id":3}'
# → invalid X-RaceHound-Req header
```

---

## Two different "race detectors": do not mix them up

| | `go test -race` | RaceHound |
|---|---|---|
| Finds | Two **goroutines in Go code** touching the same variable without a lock | Two **HTTP requests** whose SQL statements interleave badly in the **database** |
| How | Go adds checks to every memory access while the program runs | A proxy holds SQL statements and replays them in chosen orders |
| Would it catch the coupon bug? | **No.** The Go code has no shared variable; the shared thing is a database row | **Yes**, that is its whole job |

We use `go test -race` to check *RaceHound's own* code (the proxy will be heavily concurrent).
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
- **Invariant**: a rule that must always hold, e.g. `uses <= max_uses`. RaceHound checks
  invariants after every run.
- **Interleaving / schedule**: one specific order in which the statements of concurrent requests
  ran. RaceHound tries many of them.
- **Proxy**: a program in the middle. The app connects to it as if it were Postgres; it passes
  traffic on to the real Postgres and can inspect or delay it.
- **Wire protocol**: the exact byte format two programs use to talk over the network.
- **Simple vs extended protocol**: two ways to send SQL to Postgres. Simple sends a whole query
  in one `Q` message, which is easy to hold and release. Extended splits it into several
  messages (Parse/Bind/Execute). The MVP only schedules simple-protocol queries, so victim apps
  force `simple_protocol`.
- **Connection pool**: the app keeps a few database connections open and reuses them, instead
  of connecting per request.
- **Request tag**: the name (A, B, ...) RaceHound gives each HTTP request. The app copies it
  into a SQL comment, `/* rh:req=A */`, so the proxy knows which request a statement is from.
- **SQL injection**: user input pasted into SQL that changes what the SQL does. Why the app
  checks the tag header before using it.
- **Goroutine / channel / WaitGroup**: Go's lightweight thread / a pipe for passing values (or
  signals) between goroutines / a counter for waiting until a group of goroutines is done.

---

## Folder map

```
README.md                 this file
go.mod, go.sum            Go module "racehound" and its one dependency (pgx, the Postgres driver)
docs/                     SPEC, ARCHITECTURE, ROADMAP, DECISIONS, OVERVIEW, RESULTS
cmd/racehound/            the racehound command (today: just `racehound proxy`)
internal/pgwire/          message framing + startup packets (Phase 1, step 1)
internal/proxy/           pass-through proxy (Phase 1, step 2) + request tags (step 3)  ← newest
cmd/bench/                load generator for the proxy overhead measurement
victims/coupon/           the buggy coupon app, its seed data, README and exit test
docker-compose.yml        only for other people / the final demo; not used on this machine
```

---

## What comes next (rest of Phase 1)

1. ~~**Proxy, pass-through mode**~~: done (section 5 above).
2. ~~**You:** measure how much slower requests are through the proxy than direct~~: done
   (`docs/RESULTS.md`; write batching made the proxy 20.5% faster).
3. ~~**Request tags**~~: done (section 6 above).
4. **You:** the first scheduler (`internal/sched`): hold statements and release them in a
   hard-coded order.
5. **Kill test** (Phase 1 exit): one hard-coded order causes the double-redeem 10 out of 10
   times, and the opposite order never does.

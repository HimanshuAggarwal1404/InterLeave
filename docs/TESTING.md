# Interleave: Testing

Every test command, what it proves and how long it takes, plus manual checks to try by hand.
Run everything from Git Bash in the repo folder, after `npm install` once. Tests that need the
local Postgres (127.0.0.1:5432, database `interleave`) skip themselves if it is not running.
Durations were measured on the development laptop (2026-10-10; Phase 2 rows 2026-11-11).

## Commands

| Command | What it proves | Time |
|---|---|---|
| `npx tsc --noEmit` (or `npm run typecheck`) | Every file type-checks under `strict`, and uses only TypeScript syntax that Node can strip (`erasableSyntaxOnly`). Prints nothing when fine. | ~1 s |
| `npm test` | The whole suite (~225 tests): pgwire framing on captured bytes, the proxy against a fake and the real Postgres, batching and backpressure, tags, step results, the scheduler hook, both schedulers' specs, the explorers, scenario parsing, the harness, reset, the oracle, the runner and report, the CLI, the bench helpers; then the victims: the coupon app (race exists, fix holds, tags, simple protocol, escaping), the kill test, `interleave run`/`replay` on coupon (in-process and as a real CLI process), and every victim's sequential behaviour. It is two runs: `src/` files in parallel, then the victim files one at a time, because they share tables (in parallel, one file's `TRUNCATE` would wait on the kill test's deliberately held transaction). Each test file runs in its own process; a file whose process does not exit after its tests (a leaked socket or timer) makes the run hang, so a run that finishes is itself evidence. | ~5 s |
| `npm run test:repeat` | The pgwire, proxy and sched suites 20 times in a row, stopping at the first failure. Timing-dependent bugs show up as an occasional failure; this is the stand-in for a race detector (see below). `node scripts/repeat.ts N [globs]` runs other files or another count. | ~23 s |
| `npm run test:sched` | Just the schedulers: their specs (`src/sched/sched.test.ts` for the Phase 1 fixed-order scheduler, `src/sched/run.test.ts` for RunScheduler) and the Phase 1 kill test (`victims/coupon/kill.test.ts`: the bad order double-redeems 10/10, the serial order never). Both are also part of `npm test`. | ~2 s |
| `npm run test:acceptance` | SPEC section 8 for all 8 victims (`victims/acceptance.e2e.ts`): exhaustive finds the race and the finding replays identically 3 times, the fixed variant is clean in every order (exploration complete), random with seed 1 finds the race, and with the invariants removed the serial oracle alone finds it (the Phase 3 exit test). Writes the numbers for `docs/RESULTS.md` to `.interleave/acceptance-results-pg.json`; `INTERLEAVE_LOCK_DETECT=timeout npm run test:acceptance` runs it with the old 200 ms lock-wait timeout instead (`-timeout.json`), for the comparison. Not part of `npm test` (slow; shares the victims' tables). | ~20 s (timeout mode ~65 s) |
| `node --test <file>` | One file, e.g. `node --test src/proxy/forward.test.ts`. | |
| `node --test --test-name-pattern=<regex> <file>` | One test, e.g. `--test-name-pattern=RaceIsReal victims/coupon/app.test.ts`. | |
| `npm run bench -- [flags] [URL ...]` | Not a test: measures requests/sec and latency (see `docs/RESULTS.md` for setup and commands). | minutes |

All test commands use `--test-timeout=60000`: a single test that waits too long fails instead of
hanging the run. None use `--test-force-exit`, which would hide leaks.

## How concurrency is tested without a race detector

Go has `go test -race`, which watches every memory access for two threads touching the same
variable without a lock. Node has no such tool, and mostly does not need one: all JavaScript runs
on **one thread**, so two pieces of code never change a variable at the same instant. There are no
data races in that sense.

What Node does have is **async interleaving**. Every `await` pauses one function and lets other
code run: another connection's pump, a timer, the scheduler. A value read before an `await` may
have changed after it, two connections' steps can arrive in any order, and a Promise that nobody
resolves waits forever. Those are the bugs that matter here, and they are tested like this:

- **One test per ordering rule.** For example: anything held back is written before the hook may
  wait (`ForwardSendsHeldBytesBeforeInspect`); a reply is fully written before "step done" is
  reported (`ForwardReportsReadyAfterSendingIt`); every Query takes a slot in the done queue even
  when untagged, so pipelined replies pair correctly (`DoneGetsEachQuerysReadyStatus`); a slow
  reader makes the proxy wait instead of buffering (`ForwardWaitsForDrain`).
- **Repetition.** `npm run test:repeat` runs the concurrent suites 20 times; an order-dependent bug
  fails some of the runs.
- **No hangs, no leaks.** Shutdown tests compare the number of open sockets, servers and timers
  (`process.getActiveResourcesInfo()`) before and after; every wait in a test has a deadline;
  test cleanup always runs every step (`src/testutil/cleanup.ts`), so one failure cannot leave
  sockets open; and since `--test-force-exit` is never used, anything left open keeps the test
  process alive and the run visibly hangs.
- **Mutation checks.** For the delicate rules, the code was broken on purpose (skip the
  placeholder, ignore the abort signal, report before flushing, skip the flush before the hook,
  accept tags anywhere, stop waiting for drain) and the matching test had to fail.
- **Real clients.** node-postgres and psql run through the proxy against the real Postgres 18.

The scheduler's spec does the same for `sched`: `notWithin` checks a step is *not* released early
(150 ms, which can only catch a wrong release, never fail a correct scheduler) and `receive` checks
it *is* released within 5 s.

## Try it yourself (manual checks)

Reset the coupon data first whenever you start over:
```bash
psql "postgresql://interleave:interleave@127.0.0.1:5432/interleave" -f victims/coupon/seed.sql
```

**The bug exists, the fix holds** (blasting, no Interleave involved):
```bash
node --test --test-name-pattern="RaceIsReal|FixedNeverOverRedeems" victims/coupon/app.test.ts
# ✔ RaceIsReal ... ℹ round 2: single-use coupon redeemed 7 times
```

**The app through the proxy, with request tags.** Three terminals:
```bash
npm run proxy -- --verbose                      # terminal 1: logs every query with its tag
npm run coupon                                  # terminal 2: default DSN = the proxy on 127.0.0.1:6433
curl -X POST http://127.0.0.1:8081/redeem -H "X-Interleave-Req: A" -d '{"code":"DIWALI50","user_id":1}'   # terminal 3 → redeemed
curl -X POST http://127.0.0.1:8081/redeem -H "X-Interleave-Req: B" -d '{"code":"DIWALI50","user_id":2}'   #            → coupon already used up
curl -X POST http://127.0.0.1:8081/redeem -H "X-Interleave-Req: A */ DROP TABLE coupons; --" -d '{}'       #            → 400, no SQL runs
```
Terminal 1 shows `query [A] /* il:req=A */ BEGIN` ... `COMMIT`, then B's `BEGIN`, `SELECT` and
`ROLLBACK`. Ctrl+C in terminal 1 prints `interleave proxy: stopped`.

**A real client that asks for SSL first** (psql's default), through the proxy:
```bash
psql "postgresql://interleave:interleave@127.0.0.1:6433/interleave" -c "SELECT 1"
```

**The blast through the proxy** (proxy running in terminal 1):
```bash
INTERLEAVE_TEST_DSN="postgres://interleave:interleave@127.0.0.1:6433/interleave?sslmode=disable" \
  node --test --test-name-pattern="RaceIsReal|FixedNeverOverRedeems" victims/coupon/app.test.ts
```

**Find a race with Interleave.** Two terminals. The app's database is Interleave's proxy, which
`interleave run` starts itself (the app only warns until it is up):
```bash
node victims/inventory/main.ts                              # terminal 1 (add --fixed: no race)
npm run interleave -- run victims/inventory/scenario.yaml   # terminal 2: timeline, exit code 1
npm run interleave -- replay .interleave/inventory-last-item-3.json --step   # Enter per statement
```
Every victim works the same way: `victims/<name>/main.ts` and `victims/<name>/scenario.yaml`
(ports 8081-8088). `--strategy random --seed 7` explores randomly; `--all` keeps going and
reports every distinct violation.

**Break something and watch a test catch it.** In `src/proxy/forward.ts`, delete the line
`await flush(dst, held, signal);` just above `await inspect(m);`, then run
`node --test src/proxy/forward.test.ts`: `ForwardSendsHeldBytesBeforeInspect` fails. Undo with
`git checkout src/proxy/forward.ts`.

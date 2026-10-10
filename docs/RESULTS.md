# Interleave: Results

Measured numbers only. Every entry: date, git commit, machine, exact command. Never round up,
never estimate. These numbers feed the README and resume bullets, so they must be reproducible.

## Machine
- Intel Core i5-1340P, 15.6 GB RAM, Windows 11 Home (10.0.26200), PostgreSQL 18.6 (native service)
- From 2026-10-10: Node.js v24.13.0 (TypeScript implementation). Before: Go 1.27.1 (Go implementation)

## Pass-through overhead, TypeScript implementation (Phase 1, 2026-10-10)

Setup: everything on this laptop at once. A = coupon app straight to Postgres (`--addr
127.0.0.1:8081 --dsn ...@127.0.0.1:5432/...`), B = app via the TS proxy at 9fccefd (`node
src/cli/main.ts proxy`, :6433, app on 8082), C = app via the Go proxy built from the same tree
(`go-final` code, `bin/interleave-go.exe proxy --listen 127.0.0.1:6434`, app on 8083), D = app via
the TS proxy with TCP_NODELAY, b3d9af3 (`--listen 127.0.0.1:6435`, app on 8084). The app is the
TypeScript coupon victim in all four. Workload as before: DB reset with `seed.sql`, so every
measured request is a 409 (BEGIN, SELECT, ROLLBACK = 3 round trips, no locks). 0 errors in every run.

**Latency the proxy adds (1 worker, no queueing): the overhead measure for this implementation.**
Command: `node src/bench/main.ts --workers 1 --rounds 4 http://127.0.0.1:8081/redeem
http://127.0.0.1:8082/redeem http://127.0.0.1:8083/redeem http://127.0.0.1:8084/redeem`
(3s warmup per target, 4 alternating rounds of 10s). p50 values are the median of the 4 rounds' p50s.

| Target | p50 per request | Added vs direct | Added per round trip | Median req/s (min-max) |
|---|---|---|---|---|
| A direct | 389 µs | | | 2269.4 (2196.2-2304.9) |
| B TS proxy (9fccefd) | 570.5 µs | +181.5 µs | ~60 µs | 1535.1 (1452.7-1555.2) |
| C Go proxy (go-final) | 552 µs | +163 µs | ~54 µs | 1574.6 (1541.1-1726.8) |
| D TS proxy + TCP_NODELAY (b3d9af3) | 562 µs | +173 µs | ~58 µs | 1550.5 (1523.8-1616.8) |

**Throughput at the default 16 workers.** Command: `node src/bench/main.ts --rounds 4` with the
same 4 URLs. Medians (min-max): A 5471.5 (5418.9-5571.8), B 5307.6 (5264.3-5490.8), C 5359.0
(5289.8-5695.3), D 5565.1 (5497.9-5643.7) req/s; B -3.0%, C -2.1%, D +1.7% vs A. p50 2.6-2.9 ms everywhere.

Notes:
- The 16-worker numbers cannot show proxy overhead: the TypeScript victim runs on one thread and
  saturates at ~5.5k req/s, so requests queue in the app and the proxy's extra latency is hidden
  in that queue. The bench itself is not the limit: against a trivial HTTP server it did 14338.1
  req/s (16 workers, 3s). Probe of the victim alone, direct: 2047.5 req/s with 1 worker, 5776.7
  with 4, 5655.0 with 10, 5508.2 with 16 (3s each).
- So the comparable overhead number is the 1-worker added latency: the TS proxy adds ~60 µs per
  round trip, the Go proxy ~54 µs, on the same machine in the same alternating run. TCP_NODELAY
  (D vs B) made no difference beyond noise; it is kept because Go sets it by default.
- Not comparable with the Go-era rows below: those used the Go victim (multi-threaded, ~17-20k
  req/s direct) and measured added latency at 16 workers.
- The laptop changes speed between runs: an earlier run of the same 1-worker command (3 targets,
  19:19) had direct p50 around 0.95 ms in rounds 1-3 and 0.385 ms in round 4. The run above was
  steady in all 4 rounds (direct 386-394 µs); the very first 16-worker run (19:16) ran at ~2.2k
  req/s for every target. Trust the alternating within-run comparison, not absolute numbers.
- Write batching (D-014) carries over: forward tests prove one write per burst, so there was no
  per-write overhead to fix with cork/uncork.

## Pass-through overhead, historical (Go implementation)
| Date | Commit | Requests/sec direct | Requests/sec via proxy | Overhead | Command |
|---|---|---|---|---|---|
| 2026-10-04 (run 1, setups one after the other) | f3b9be1 (proxy); first version of `cmd/bench`, committed in fd9fddb | 20766.9 median (18593.0-22885.4) | 11346.1 median (10628.9-12039.0) | 45.4% fewer req/s; p50 577µs → 1.259ms | `go run ./cmd/bench` (defaults: 16 workers, 3s warmup, 3 x 10s) |
| 2026-10-04 (run 2, alternating), old proxy | f3b9be1 (`bin/interleave-old.exe`) | 17575.1 median (15273.1-23735.2) | 9414.3 median (8627.7-10889.9) | 46.4% fewer req/s; p50 695.5µs → 1.673ms | `go run ./cmd/bench --rounds 4 http://localhost:8081/redeem http://localhost:8082/redeem http://localhost:8083/redeem` (old proxy = 8082) |
| 2026-10-04 (run 2, alternating), new proxy | fd9fddb (write batching) | same run as above | 11348.4 median (10644.5-11716.6) | 35.4% fewer req/s; p50 695.5µs → 1.223ms | same command as above (new proxy = 8083) |

### Before/after: write batching in the proxy (old vs new, run 2), historical (Go implementation)

Date: 2026-10-04. Before = commit f3b9be1 (one `Write` per message). After = write batching,
**fd9fddb**. Both proxies and
the direct app ran at the same time and were measured in alternating order, so they share
conditions. Direct baseline in the same run: 17575.1 req/s, p50 695.5 µs.

Exact bench command:
`go run ./cmd/bench --rounds 4 http://localhost:8081/redeem http://localhost:8082/redeem http://localhost:8083/redeem`
(defaults: 16 workers, 3s warmup per target, 10s per round; 8081 = direct, 8082 = old proxy,
8083 = new proxy).

| Metric | Old proxy (before) | New proxy (after) | Change |
|---|---|---|---|
| Throughput, median req/s (min-max over 4 rounds) | 9414.3 (8627.7-10889.9) | 11348.4 (10644.5-11716.6) | +20.5%; new faster in 4/4 rounds (+7.6%, +17.0%, +24.2%, +23.4%) |
| Throughput vs direct (medians) | -46.4% | -35.4% | 11.0 points less overhead |
| p50 latency per request | 1.673 ms | 1.223 ms | -0.45 ms |
| Added latency per request (p50 minus direct p50) | 0.98 ms | 0.53 ms | -46% |
| Added latency per round trip (3 per request) | 0.33 ms | 0.18 ms | |

The old-vs-new comparison is the reliable result. The vs-direct percentages have wide error bars
because direct swung between 15.3k and 23.7k req/s across rounds (see notes below).

2026-10-04 run 2 notes:
- Command: `go run ./cmd/bench --rounds 4 http://localhost:8081/redeem http://localhost:8082/redeem
  http://localhost:8083/redeem`. A = app direct (:5432), B = app via old proxy
  (`bin/interleave-old.exe proxy --listen localhost:6434`, built from f3b9be1), C = app via new proxy
  (`go run ./cmd/interleave proxy`, :6433). All 5 processes ran at once; each round measured A, B, C
  for 10s each, order alternating (ABC, CBA, ABC, CBA). 0 errors. Same workload as run 1.
- p50 values are the median of the 4 rounds' p50s.
- New vs old proxy, same round (they always ran next to each other): +7.6%, +17.0%, +24.2%, +23.4%
  req/s. The new proxy was faster in 4 of 4 rounds; +20.5% on medians. Latency the proxy adds to a
  request (p50 vs direct): 0.98 ms → 0.53 ms, about 0.18 ms per round trip now.
- Direct was very unsteady (23.7k → 17.7k → 17.5k → 15.3k; round 4 p99 jumped to ~4 ms for all
  three), so the "% vs direct" numbers have wide error bars. The old-vs-new comparison is the
  reliable result of this run.
- A quick smoke run before this one (4 x 2s, 2 targets) showed the new proxy at -14.1% vs direct.
  This run did not reproduce that; trust this run, not the smoke run.

2026-10-04 run 1 notes:
- Workload: coupon app, DB reset with `seed.sql`, so every measured request is a 409 (BEGIN,
  SELECT, ROLLBACK = 3 round trips, no locks). Direct: app `--dsn` on :5432. Via proxy:
  `go run ./cmd/interleave proxy` + app with default DSN (:6433). 0 errors in both. The bench, app,
  proxy and Postgres all ran on the same laptop.
- The ranges do not overlap (direct min 18593.0 > proxy max 12039.0), so the gap is real.
  Median p50 latency went up by ~0.68 ms per request, i.e. ~0.23 ms per round trip.
- Rounds got slower one after another in both setups (direct 22.9k → 20.8k → 18.6k, proxy 12.0k →
  11.3k → 10.6k), probably because the laptop heats up and its CPU slows down. Setups ran one
  after the other (direct first), which may favour direct a little. Rerun with setups alternating
  before quoting a precise percentage.
- This is a worst case: tiny queries on a local DB, so the proxy's extra hop is a large share of
  each request. Do not quote it as overhead "for apps in general".
- Suspected cause: `proxy.forward` does one unbuffered `Write` per message. Postgres sends a
  query's reply (RowDescription, DataRow, CommandComplete, ReadyForQuery) as one TCP write; the
  proxy splits it into 4 writes. Confirmed as part of the cost in run 2 (see Optimisations).

## Detection per victim (Phase 2 onward)
| Date | Commit | Victim | Strategy | Seed | Found? | Runs to first violation | Runs/sec | Resets/sec | Fixed variant clean? |
|---|---|---|---|---|---|---|---|---|---|

## Baseline: naive concurrent blasting (for comparison)
| Date | Victim | Requests fired per trial | Trials | Trials that exposed the bug |
|---|---|---|---|---|
| 2026-10-03 | coupon | 50 | 12 | 6 (over-redeemed 2-5x) |

2026-10-03 note (pre-first-code-commit): trial = one `TestRaceIsReal` round, which stops at the
first exposing round, over 6 invocations of `go test ./victims/coupon -run TestRaceIsReal -v
-count=N`. Round 1 (cold connection pool) exposed it 0/6 times, round 2 6/6. Not a clean rate:
redo with a fixed number of rounds per trial before quoting it.

## Optimisations (Phase 3)
The two rows below are historical (Go implementation).

| Date | Commit | Optimisation | Metric | Before | After |
|---|---|---|---|---|---|
| 2026-10-04 | before f3b9be1, after fd9fddb | Proxy write batching: send messages that arrived together in one `Write` (done in Phase 1, D-014) | req/s through proxy, coupon 409 path, median of 4 alternating rounds | 9414.3 | 11348.4 (+20.5%; faster in 4/4 rounds) |
| 2026-10-04 | same | same | p50 latency the proxy adds per request (vs direct, same run) | 0.98 ms | 0.53 ms |

Command for both rows: `go run ./cmd/bench --rounds 4 http://localhost:8081/redeem
http://localhost:8082/redeem http://localhost:8083/redeem`. Full table and setup: "Before/after:
write batching in the proxy" above.

## Real-world findings (Phase 4-5)
| Date | Project | Endpoint | Bug | Reported (link) | Status |
|---|---|---|---|---|---|

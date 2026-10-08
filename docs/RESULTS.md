# Interleave: Results

Measured numbers only. Every entry: date, git commit, machine, exact command. Never round up,
never estimate. These numbers feed the README and resume bullets, so they must be reproducible.

## Machine
- Intel Core i5-1340P, 15.6 GB RAM, Windows 11 Home (10.0.26200), Go 1.27.1, PostgreSQL 18.6 (native service)

## Pass-through overhead (Phase 1)
| Date | Commit | Requests/sec direct | Requests/sec via proxy | Overhead | Command |
|---|---|---|---|---|---|
| 2026-10-04 (run 1, setups one after the other) | f67f182 (proxy); first version of `cmd/bench`, committed in af4f09b | 20766.9 median (18593.0-22885.4) | 11346.1 median (10628.9-12039.0) | 45.4% fewer req/s; p50 577µs → 1.259ms | `go run ./cmd/bench` (defaults: 16 workers, 3s warmup, 3 x 10s) |
| 2026-10-04 (run 2, alternating), old proxy | f67f182 (`bin/interleave-old.exe`) | 17575.1 median (15273.1-23735.2) | 9414.3 median (8627.7-10889.9) | 46.4% fewer req/s; p50 695.5µs → 1.673ms | `go run ./cmd/bench --rounds 4 http://localhost:8081/redeem http://localhost:8082/redeem http://localhost:8083/redeem` (old proxy = 8082) |
| 2026-10-04 (run 2, alternating), new proxy | af4f09b (write batching) | same run as above | 11348.4 median (10644.5-11716.6) | 35.4% fewer req/s; p50 695.5µs → 1.223ms | same command as above (new proxy = 8083) |

### Before/after: write batching in the proxy (old vs new, run 2)

Date: 2026-10-04. Before = commit f67f182 (one `Write` per message). After = write batching,
**af4f09b**. Both proxies and
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
  (`bin/interleave-old.exe proxy --listen localhost:6434`, built from f67f182), C = app via new proxy
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
| Date | Commit | Optimisation | Metric | Before | After |
|---|---|---|---|---|---|
| 2026-10-04 | before f67f182, after af4f09b | Proxy write batching: send messages that arrived together in one `Write` (done in Phase 1, D-014) | req/s through proxy, coupon 409 path, median of 4 alternating rounds | 9414.3 | 11348.4 (+20.5%; faster in 4/4 rounds) |
| 2026-10-04 | same | same | p50 latency the proxy adds per request (vs direct, same run) | 0.98 ms | 0.53 ms |

Command for both rows: `go run ./cmd/bench --rounds 4 http://localhost:8081/redeem
http://localhost:8082/redeem http://localhost:8083/redeem`. Full table and setup: "Before/after:
write batching in the proxy" above.

## Real-world findings (Phase 4-5)
| Date | Project | Endpoint | Bug | Reported (link) | Status |
|---|---|---|---|---|---|

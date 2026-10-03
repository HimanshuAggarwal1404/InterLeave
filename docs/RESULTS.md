# RaceHound: Results

Measured numbers only. Every entry: date, git commit, machine, exact command. Never round up,
never estimate. These numbers feed the README and resume bullets, so they must be reproducible.

## Machine
- Intel Core i5-1340P, 15.6 GB RAM, Windows 11 Home (10.0.26200), Go 1.27.1, PostgreSQL 18.6 (native service)

## Pass-through overhead (Phase 1)
| Date | Commit | Requests/sec direct | Requests/sec via proxy | Overhead | Command |
|---|---|---|---|---|---|

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

## Real-world findings (Phase 4-5)
| Date | Project | Endpoint | Bug | Reported (link) | Status |
|---|---|---|---|---|---|

# RaceHound: Results

Measured numbers only. Every entry: date, git commit, machine, exact command. Never round up,
never estimate. These numbers feed the README and resume bullets, so they must be reproducible.

## Machine
- (fill in: CPU, RAM, OS, Go version, Postgres version)

## Pass-through overhead (Phase 1)
| Date | Commit | Requests/sec direct | Requests/sec via proxy | Overhead | Command |
|---|---|---|---|---|---|

## Detection per victim (Phase 2 onward)
| Date | Commit | Victim | Strategy | Seed | Found? | Runs to first violation | Runs/sec | Resets/sec | Fixed variant clean? |
|---|---|---|---|---|---|---|---|---|---|

## Baseline: naive concurrent blasting (for comparison)
| Date | Victim | Requests fired per trial | Trials | Trials that exposed the bug |
|---|---|---|---|---|

## Optimisations (Phase 3)
| Date | Commit | Optimisation | Metric | Before | After |
|---|---|---|---|---|---|

## Real-world findings (Phase 4-5)
| Date | Project | Endpoint | Bug | Reported (link) | Status |
|---|---|---|---|---|---|

// Types shared by the runner, the report and the CLI.
import type { Response } from '../harness/index.ts';
import type { InvariantResult, Outcome } from '../oracle/index.ts';
import type { RunTrace } from '../sched/run.ts';

// FindingKind: what went wrong in a run. 'invariant': an invariant query did
// not return true. 'deadlock': Postgres aborted a statement with 40P01 (D-024).
// 'serial': the outcome matches no one-at-a-time order of the requests (D-031).
export type FindingKind = 'invariant' | 'deadlock' | 'serial';

// ShrinkInfo says how a finding was simplified (D-033).
export type ShrinkInfo = {
  fromRun: number; // the run that first showed the bug
  fromSwitches: number; // switches between requests in that run
  toSwitches: number; // switches in the shrunk run (this result)
  attempts: number; // extra runs the shrinker made
};

// SerialCheck is the serial oracle's verdict on one run.
export type SerialCheck = {
  outcome: Outcome; // this run's outcome
  matched?: string[]; // the one-at-a-time order with the same outcome; missing = a race
  serialOutcomes: ReadonlyArray<{ order: string[]; outcome: Outcome }>; // what each order gives
};

// RunResult is everything about one run.
//   complete  every request finished
//   timeout   the run timeout fired first (FR-12: reported, not a violation)
//   error     the run could not be judged (e.g. the app behaved differently
//             from the recorded schedule it was replaying)
//   pruned    partial-order reduction cut it short: the rest could only repeat
//             orders already explored (D-034); not judged
export type RunResult = {
  index: number; // 1-based run number
  outcome: 'complete' | 'timeout' | 'error' | 'pruned';
  error?: string;
  trace: RunTrace;
  responses: Response[];
  invariants: InvariantResult[];
  serial?: SerialCheck; // set when the scenario has a serial section and the run completed
  shrunk?: ShrinkInfo; // set when this finding was shrunk (D-033)
  findings: FindingKind[]; // empty: the run is clean
  resetMs: number;
  ms: number;
};

export type Strategy = 'exhaustive' | 'random' | 'pct';

// ExploreSummary is the result of `interleave run`.
export type ExploreSummary = {
  scenarioName: string;
  scenarioFile: string;
  strategy: Strategy;
  seed: number;
  depth?: number; // pct only: the bug depth it targets (D-032)
  maxRuns: number;
  runs: number; // runs executed
  complete: boolean; // exhaustive only: every order was explored
  findings: RunResult[]; // the runs with findings (the first one, or every distinct one with --all)
  error?: string; // exploration stopped because of a problem (not a race)
  interrupted: boolean; // stopped by Ctrl+C
  seconds: number;
  resetSeconds: number; // total time spent resetting
  serialOrders?: number; // one-at-a-time orders run first for the serial oracle
  shrinkRuns?: number; // extra runs made by the shrinker (not counted in runs)
  por?: boolean; // partial-order reduction was on (D-034)
  pruned?: number; // runs cut short by it (counted in runs)
  firstFindingAfterRuns?: number;
  firstFindingAfterSeconds?: number;
};

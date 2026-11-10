// Replay: make exactly the choices recorded in a schedule file, in order. Any
// difference (a recorded choice not runnable, or more decisions than were
// recorded) means the app no longer behaves as it did, and is reported.
import type { Chooser } from '../sched/run.ts';
import { NonDeterminismError } from './errors.ts';

export function replayChooser(chosen: readonly string[]): Chooser {
  let depth = 0;
  return (runnable) => {
    const d = depth++;
    const expected = chosen[d];
    if (expected === undefined || !runnable.includes(expected)) {
      throw new NonDeterminismError(d, expected, runnable);
    }
    return expected;
  };
}

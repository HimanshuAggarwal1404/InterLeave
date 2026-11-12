// PCT: Probabilistic Concurrency Testing (Burckhardt, Kothari, Musuvathi,
// Nagarakatte, ASPLOS 2010), as a chooser (D-032).
//
// Most concurrency bugs need only a few preemptions in the right places: a
// check-then-act race needs one (stop A between its check and its act, run B).
// The number of preemptions a bug needs is its depth d. PCT, per run:
//   - gives every request a random priority; the highest-priority runnable
//     request always goes next (so no preemption happens by itself);
//   - picks d-1 random steps (change points) out of the k steps of a run; at
//     the j-th change point, the request about to run is demoted to priority j,
//     below every initial priority: a preemption, exactly there.
// For a bug of depth d this hits it with probability at least 1/(n * k^(d-1))
// per run (n requests), whereas uniform random choices hit a bug that needs a
// long uninterrupted stretch of one request with exponentially small
// probability. Seeded, so `--strategy pct --seed S` is reproducible.
import type { Chooser, Decision } from '../sched/run.ts';
import { mulberry32 } from './random.ts';

export class PctStrategy {
  readonly seed: number;
  readonly depth: number;
  readonly #next: () => number;
  // k: the number of steps (decisions) in a run. Not known in advance: the
  // first run uses a guess, later runs the most steps seen so far. (A guess
  // that stays too high would put change points after the run's end, wasted.)
  readonly #guess: number;
  #maxSeen = 0;

  constructor(seed: number, depth = 2, initialSteps = 20) {
    if (!Number.isInteger(depth) || depth < 1) {
      throw new Error(`PCT depth must be an integer >= 1, got ${depth}`);
    }
    this.seed = seed;
    this.depth = depth;
    this.#next = mulberry32(seed);
    this.#guess = initialSteps;
  }

  // nextChooser returns the chooser for the next run. PCT never runs out; the
  // runner stops it with --max-runs.
  nextChooser(): Chooser {
    const rng = this.#next;
    const d = this.depth;
    const k = this.#maxSeen > 0 ? this.#maxSeen : this.#guess;
    // The d-1 change points: distinct steps in 1..k, the j-th demotes to priority j.
    const changeAt = new Map<number, number>();
    while (changeAt.size < Math.min(d - 1, k)) {
      const step = 1 + Math.floor(rng() * k);
      if (!changeAt.has(step)) {
        changeAt.set(step, changeAt.size + 1);
      }
    }
    // Initial priorities are in [d, d+1): above every change-point priority
    // (1..d-1). A request gets its priority the first time it is runnable.
    const priority = new Map<string, number>();
    let step = 0;
    return (runnable) => {
      step++;
      for (const tag of runnable) {
        if (!priority.has(tag)) {
          priority.set(tag, d + rng());
        }
      }
      const highest = () => runnable.reduce((best, tag) => ((priority.get(tag) ?? 0) > (priority.get(best) ?? 0) ? tag : best));
      const j = changeAt.get(step);
      if (j !== undefined) {
        priority.set(highest(), j); // preempt it here
      }
      return highest();
    };
  }

  // record updates k from the run that just finished.
  record(decisions: readonly Decision[]): void {
    this.#maxSeen = Math.max(this.#maxSeen, decisions.length);
  }
}

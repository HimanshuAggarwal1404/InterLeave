// Exhaustive exploration: depth-first search over the tree of choices, by
// replay (stateless model checking, D-006).
//
// Every run is a path from the root of a tree: each node is a decision point,
// each edge a choice. The tree is not known in advance (an app may take a
// different number of steps depending on the order), so it is discovered run
// by run:
//   - run 1 always picks the first runnable request;
//   - after each run, find the deepest decision that still has an untried
//     alternative; the next run replays every choice above it, takes the next
//     alternative there, and picks first-runnable below it;
//   - when no decision has an untried alternative, every order has been run.
import type { Chooser, Decision } from '../sched/run.ts';
import { NonDeterminismError } from './errors.ts';

// Node is one decision on the path: what was runnable, and the index taken.
type Node = { runnable: string[]; index: number };

export class Exhaustive {
  // The choices the next run must replay (its prefix), or undefined when the
  // tree is exhausted.
  #prefix: Node[] | undefined = [];
  #runs = 0;

  // runs returns how many choosers have been handed out so far.
  get runs(): number {
    return this.#runs;
  }

  // nextChooser returns the chooser for the next run, or undefined when every
  // order has been explored.
  nextChooser(): Chooser | undefined {
    const prefix = this.#prefix;
    if (prefix === undefined) {
      return undefined;
    }
    this.#runs++;
    let depth = 0;
    return (runnable) => {
      const d = depth++;
      if (d < prefix.length) {
        const node = prefix[d];
        const expected = node.runnable[node.index];
        if (!runnable.includes(expected)) {
          throw new NonDeterminismError(d, expected, runnable);
        }
        return expected;
      }
      return runnable[0];
    };
  }

  // record takes the decisions of the run that just finished and computes
  // the prefix of the next run: the path up to the deepest decision with an
  // untried alternative, with that alternative taken.
  record(decisions: readonly Decision[]): void {
    const path: Node[] = decisions.map((d) => ({ runnable: [...d.runnable], index: d.runnable.indexOf(d.chosen) }));
    for (let d = path.length - 1; d >= 0; d--) {
      if (path[d].index + 1 < path[d].runnable.length) {
        this.#prefix = [...path.slice(0, d), { runnable: path[d].runnable, index: path[d].index + 1 }];
        return;
      }
    }
    this.#prefix = undefined; // no alternative left anywhere: exhausted
  }

  // done reports whether every order has been explored.
  get done(): boolean {
    return this.#prefix === undefined;
  }
}

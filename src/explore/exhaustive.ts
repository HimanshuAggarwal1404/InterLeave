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
//
// With reduce (partial-order reduction, D-034) it also keeps sleep sets
// (Godefroid): once request u has been explored at a node, trying another
// request t there only needs orders in which u runs *later*, if u's next
// statement is independent of t's (running u first would give an order
// equivalent to one already explored). So u sleeps, and is not chosen until a
// statement that conflicts with u's runs and wakes it. A run in which every
// runnable request is asleep would only repeat explored orders: the chooser
// throws PrunedRun and the run is cut short.
import type { Chooser, Decision } from '../sched/run.ts';
import { access, independent, type Access } from './access.ts';
import { NonDeterminismError } from './errors.ts';

// PrunedRun: the rest of this run can only repeat orders already explored.
export class PrunedRun extends Error {
  override name = 'PrunedRun';
  constructor() {
    super('every runnable request is asleep: this order was already covered (partial-order reduction)');
  }
}

// Node is one decision on the path: what was runnable, the index taken, and
// (reduce) the requests already explored here before that index.
type Node = { runnable: string[]; index: number; explored: string[] };

// What the chooser saw at each depth of the current run (reduce): the sleep
// set on arriving there, and each runnable request's next statement.
type Seen = { sleep: string[]; next: Map<string, Access> };

export class Exhaustive {
  // The choices the next run must replay (its prefix), or undefined when the
  // tree is exhausted.
  #prefix: Node[] | undefined = [];
  #runs = 0;
  readonly #reduce: boolean;
  #seen: Seen[] = [];

  constructor(options: { reduce?: boolean } = {}) {
    this.#reduce = options.reduce ?? false;
  }

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
    const seen: Seen[] = [];
    this.#seen = seen;
    let depth = 0;
    let sleep: string[] = [];
    return (runnable, nextSql) => {
      const d = depth++;
      const next = new Map([...nextSql].map(([tag, sql]) => [tag, access(sql)]));
      seen[d] = { sleep: [...sleep], next };
      let chosen: string;
      let explored: string[] = [];
      if (d < prefix.length) {
        const node = prefix[d];
        chosen = node.runnable[node.index];
        if (!runnable.includes(chosen)) {
          throw new NonDeterminismError(d, chosen, runnable);
        }
        explored = node.explored;
      } else {
        const awake = this.#reduce ? runnable.filter((tag) => !sleep.includes(tag)) : runnable;
        if (awake.length === 0) {
          throw new PrunedRun();
        }
        chosen = awake[0];
      }
      if (this.#reduce) {
        // The child's sleep set: what slept here or was explored here, if
        // independent of the chosen statement; a dependent one wakes up.
        const mine = next.get(chosen);
        sleep = [...new Set([...sleep, ...explored])].filter((tag) => {
          const theirs = next.get(tag);
          return tag !== chosen && mine !== undefined && theirs !== undefined && independent(theirs, mine);
        });
      }
      return chosen;
    };
  }

  // record takes the decisions of the run that just finished (possibly cut
  // short by PrunedRun) and computes the prefix of the next run: the path up
  // to the deepest decision with an untried (and, with reduce, awake)
  // alternative, with that alternative taken.
  record(decisions: readonly Decision[]): void {
    const old = this.#prefix ?? [];
    const path: Node[] = decisions.map((dec, d) => ({
      runnable: [...dec.runnable],
      index: dec.runnable.indexOf(dec.chosen),
      explored: d < old.length ? old[d].explored : [],
    }));
    for (let d = path.length - 1; d >= 0; d--) {
      const node = path[d];
      const asleep = this.#reduce ? (this.#seen[d]?.sleep ?? []) : [];
      const explored = [...node.explored, node.runnable[node.index]];
      const alt = node.runnable.findIndex((tag, j) => j > node.index && !asleep.includes(tag) && !explored.includes(tag));
      if (alt >= 0) {
        this.#prefix = [...path.slice(0, d), { runnable: node.runnable, index: alt, explored }];
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

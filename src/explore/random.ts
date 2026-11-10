// Random exploration: at each decision point pick uniformly among the
// runnable requests. Seeded, so the same scenario, seed and app give the same
// sequence of orders (NFR-2): `--strategy random --seed S` is reproducible.
import type { Chooser } from '../sched/run.ts';

// mulberry32 is a small, well-known 32-bit pseudo-random generator: from a
// seed it produces the same sequence of numbers in [0, 1) every time.
// (Math.random cannot be seeded, which is why we do not use it.)
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RandomStrategy {
  readonly seed: number;
  readonly #next: () => number;

  constructor(seed: number) {
    this.seed = seed;
    this.#next = mulberry32(seed); // one stream for the whole exploration
  }

  // nextChooser returns the chooser for the next run. Random never runs out;
  // the runner stops it with --max-runs.
  nextChooser(): Chooser {
    return (runnable) => runnable[Math.floor(this.#next() * runnable.length)];
  }
}

// NonDeterminismError means a replayed run did not behave like the run it
// replays: at decision `depth` the choice that was taken before is no longer
// runnable. The app depends on something besides the order (time, randomness,
// leftover data), so its schedules cannot be replayed reliably.
export class NonDeterminismError extends Error {
  override name = 'NonDeterminismError';
  readonly depth: number;

  constructor(depth: number, expected: string | undefined, runnable: readonly string[]) {
    super(
      expected === undefined
        ? `non-deterministic app: decision ${depth + 1} was not in the recorded schedule (runnable: ${runnable.join(', ')})`
        : `non-deterministic app: at decision ${depth + 1} the recorded choice ${expected} is not runnable (runnable: ${runnable.join(', ') || 'none'})`,
    );
    this.depth = depth;
  }
}

// lineReader hands out the lines of an input stream one at a time, for
// `replay --step` ("press Enter to run the next statement").
//
// readline's question() does not work with piped input: readline reads every
// piped line at once, nobody is asking yet, and then it closes, so the first
// question fails with "readline was closed". Here every line is queued as it
// arrives, and next() takes the oldest one, or waits for the next one. At the
// end of input next() resolves with undefined, so a replay fed a few Enters
// finishes instead of hanging.
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

export type LineReader = {
  next(): Promise<string | undefined>;
  close(): void;
};

export function lineReader(input: Readable): LineReader {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const queued: string[] = [];
  const waiting: Array<(line: string | undefined) => void> = [];
  let ended = false;
  rl.on('line', (line) => {
    const wake = waiting.shift();
    if (wake !== undefined) {
      wake(line);
    } else {
      queued.push(line);
    }
  });
  rl.on('close', () => {
    ended = true;
    for (const wake of waiting.splice(0)) {
      wake(undefined);
    }
  });
  return {
    next(): Promise<string | undefined> {
      if (queued.length > 0) {
        return Promise.resolve(queued.shift());
      }
      if (ended) {
        return Promise.resolve(undefined);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    close(): void {
      rl.close();
    },
  };
}

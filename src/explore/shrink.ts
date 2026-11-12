// The shrinker (D-033): turns a finding into a simpler order that still
// shows the same bug, so the timeline only contains the switches that matter.
//
// A finding's choices read as segments: runs of one request (A A A, B B, A).
// Every boundary between segments is a switch from one request to another.
// The shrinker repeatedly tries to remove one segment: the statements it held
// then run in that request's next segment. A candidate is kept only if a real
// run of it still shows the bug; when no single removal works any more, it
// stops. (A greedy form of delta debugging over segments.)
import type { Chooser, Decision } from '../sched/run.ts';

export type Segment = { tag: string; length: number };

export function segments(choices: readonly string[]): Segment[] {
  const out: Segment[] = [];
  for (const tag of choices) {
    const last = out.at(-1);
    if (last !== undefined && last.tag === tag) {
      last.length++;
    } else {
      out.push({ tag, length: 1 });
    }
  }
  return out;
}

// switches counts how often the order moves from one request to another.
export function switches(choices: readonly string[]): number {
  return Math.max(segments(choices).length - 1, 0);
}

// segmentChooser follows segments leniently: each segment's request goes up
// to `length` times while it is runnable; a segment that cannot be followed
// is skipped. After the last segment, it keeps choosing the request it chose
// last while that one is runnable (no new switches). It never throws: a
// candidate that makes the app behave differently simply does not reproduce.
export function segmentChooser(segs: readonly Segment[]): Chooser {
  let index = 0;
  let used = 0;
  let last: string | undefined;
  return (runnable) => {
    while (index < segs.length) {
      const seg = segs[index];
      if (used < seg.length && runnable.includes(seg.tag)) {
        used++;
        last = seg.tag;
        return seg.tag;
      }
      index++;
      used = 0;
    }
    last = last !== undefined && runnable.includes(last) ? last : runnable[0];
    return last;
  };
}

// shrink returns the simplest schedule found that still reproduces, and how
// many attempts (runs) it took. attempt runs one candidate and returns its
// decisions if the same bug showed up, or undefined if it did not.
export async function shrink(
  choices: readonly string[],
  attempt: (choose: Chooser) => Promise<readonly Decision[] | undefined>,
): Promise<{ choices: string[]; attempts: number }> {
  let best = [...choices];
  let attempts = 0;
  for (let progress = true; progress; ) {
    progress = false;
    const segs = segments(best);
    for (let i = 0; i < segs.length && segs.length > 1; i++) {
      const candidate = [...segs.slice(0, i), ...segs.slice(i + 1)];
      attempts++;
      const decisions = await attempt(segmentChooser(candidate));
      if (decisions === undefined) {
        continue;
      }
      const tried = decisions.map((d) => d.chosen);
      if (switches(tried) < switches(best)) {
        best = tried; // what really ran: replayable as it is
        progress = true;
        break;
      }
    }
  }
  return { choices: best, attempts };
}

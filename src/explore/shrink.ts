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
  // With n requests, running them one after another takes n-1 switches and
  // is not a race; so n switches (one preemption) is as simple as a race
  // gets. Stop there instead of trying to beat it.
  const floor = new Set(choices).size;
  if (switches(best) <= floor) {
    return { choices: best, attempts };
  }
  // First the simplest bad orders there are, tried directly: one preemption.
  // Most races need no more (a check-then-act race needs one request stopped
  // between its check and its act), and greedy steps cannot always get there:
  // splitting a segment first adds a switch.
  for (const candidate of onePreemption(best)) {
    attempts++;
    const decisions = await attempt(segmentChooser(candidate));
    const tried = decisions?.map((d) => d.chosen);
    if (tried !== undefined && switches(tried) < switches(best)) {
      best = tried;
      if (switches(best) <= floor) {
        return { choices: best, attempts };
      }
    }
  }
  // Then greedy steps, for races that need more than one preemption.
  for (let progress = switches(best) > floor; progress; ) {
    progress = false;
    for (const candidate of candidates(segments(best))) {
      attempts++;
      const decisions = await attempt(segmentChooser(candidate));
      if (decisions === undefined) {
        continue;
      }
      const tried = decisions.map((d) => d.chosen);
      if (switches(tried) < switches(best)) {
        best = tried; // what really ran: replayable as it is
        progress = switches(best) > floor;
        break;
      }
    }
  }
  return { choices: best, attempts };
}

// onePreemption yields every order with a single preemption: request X runs
// its first a statements, then each other request runs completely, then X
// finishes (for every X and every split point a).
function* onePreemption(choices: readonly string[]): Generator<Segment[]> {
  const counts = new Map<string, number>();
  for (const tag of choices) {
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  for (const [x, n] of counts) {
    const others = [...counts].filter(([tag]) => tag !== x).map(([tag, length]) => ({ tag, length }));
    for (let a = 1; a < n; a++) {
      yield [{ tag: x, length: a }, ...others, { tag: x, length: n - a }];
    }
  }
}

// candidates yields simpler segment lists, one segment changed each:
//   - move its statements earlier: onto the previous segment of the same
//     request (or to the very front if there is none);
//   - move them later: onto the next segment of the same request (or to the
//     very end);
//   - drop it (its statements then run wherever the chooser allows).
// Moving keeps every request's statement count, which matters when a
// statement waits for a lock: dropping alone leaves the remaining segments too
// short, and the bad order falls apart.
function* candidates(segs: readonly Segment[]): Generator<Segment[]> {
  if (segs.length <= 1) {
    return;
  }
  for (let i = 0; i < segs.length; i++) {
    const { tag, length } = segs[i];
    const without = [...segs.slice(0, i), ...segs.slice(i + 1)];
    const before = segs.slice(0, i).map((s) => s.tag).lastIndexOf(tag);
    yield before >= 0 ? grow(without, before, length) : [{ tag, length }, ...without];
    const after = segs.slice(i + 1).findIndex((s) => s.tag === tag);
    yield after >= 0 ? grow(without, i + after, length) : [...without, { tag, length }];
    yield without;
  }
}

// grow returns segs with segment i made longer by extra.
function grow(segs: readonly Segment[], i: number, extra: number): Segment[] {
  return segs.map((s, j) => (j === i ? { tag: s.tag, length: s.length + extra } : { ...s }));
}

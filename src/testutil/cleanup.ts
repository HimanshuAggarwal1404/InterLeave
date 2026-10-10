// onCleanup registers fn to run when test t ends, like Go's t.Cleanup:
// cleanups run last-registered first, and every one runs even if an earlier
// one fails (node:test skips the remaining t.after hooks once one throws, so a
// failed shutdown check would otherwise leave sockets open and hang the run).
// The first error is rethrown after all of them have run, failing the test.
import type { TestContext } from 'node:test';

const cleanups = new WeakMap<TestContext, Array<() => unknown>>();

export function onCleanup(t: TestContext, fn: () => unknown): void {
  let list = cleanups.get(t);
  if (list === undefined) {
    list = [];
    cleanups.set(t, list);
    const fns = list;
    t.after(async () => {
      let first: unknown;
      for (const f of fns.reverse()) {
        try {
          await f();
        } catch (err) {
          first ??= err;
        }
      }
      if (first !== undefined) {
        throw first;
      }
    });
  }
  list.push(fn);
}

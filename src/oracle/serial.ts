// The serial-equivalence oracle (D-031). A concurrent run is correct only if
// its outcome equals the outcome of the same requests run one at a time, in
// some order. So the runner first runs every one-at-a-time order and records
// each outcome here; afterwards every concurrent run's outcome must match one
// of them. No hand-written invariant is needed.
//
// An outcome is the values of the columns the scenario lists (rows sorted, so
// the order rows were inserted in does not matter) plus each request's HTTP
// status.
import type pg from 'pg';
import type { SerialTable } from '../scenario/index.ts';

export type Outcome = {
  tables: Record<string, unknown[][]>; // table → its rows, each row the listed columns' values
  statuses: Record<string, number>; // request tag → HTTP status
};

// serialOrders returns every order of the tags (all permutations), starting
// with the tags in request order.
export function serialOrders(tags: readonly string[]): string[][] {
  if (tags.length <= 1) {
    return [[...tags]];
  }
  return tags.flatMap((first, i) => serialOrders([...tags.slice(0, i), ...tags.slice(i + 1)]).map((rest) => [first, ...rest]));
}

// snapshot reads the listed columns of each table, rows sorted by every
// column. Table and column names were checked to be plain identifiers when
// the scenario was loaded, so they can go into the SQL as they are.
export async function snapshot(client: pg.Client, tables: readonly SerialTable[]): Promise<Record<string, unknown[][]>> {
  const result: Record<string, unknown[][]> = {};
  for (const { table, columns } of tables) {
    const order = columns.map((_, i) => i + 1).join(', ');
    try {
      const res = await client.query({ text: `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order}`, rowMode: 'array' });
      result[table] = res.rows as unknown[][];
    } catch (err) {
      throw new Error(`serial snapshot of ${table} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return result;
}

// key turns an outcome into a string that is the same for equal outcomes,
// whatever order their keys were added in.
function key(o: Outcome): string {
  const sorted = (r: Record<string, unknown>) => Object.keys(r).sort().map((k) => [k, r[k]]);
  return JSON.stringify([sorted(o.tables), sorted(o.statuses)]);
}

export class SerialOracle {
  readonly #byKey = new Map<string, string[]>();
  readonly outcomes: Array<{ order: string[]; outcome: Outcome }> = [];

  // record remembers the outcome of one one-at-a-time order.
  record(order: readonly string[], outcome: Outcome): void {
    this.outcomes.push({ order: [...order], outcome });
    const k = key(outcome);
    if (!this.#byKey.has(k)) {
      this.#byKey.set(k, [...order]);
    }
  }

  // match returns a serial order with exactly this outcome, or undefined if
  // there is none: then the concurrent run produced a result that no
  // one-at-a-time execution can produce, which is a race.
  match(outcome: Outcome): string[] | undefined {
    const order = this.#byKey.get(key(outcome));
    return order === undefined ? undefined : [...order];
  }
}

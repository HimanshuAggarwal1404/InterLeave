// Package oracle judges a run: after every run it executes the scenario's
// invariant queries on the admin connection (FR-18). An invariant holds only
// if its query returns exactly one row with one column whose value is true;
// anything else (false, NULL, no row, two rows, a number) is a violation.
import type pg from 'pg';
import type { Invariant } from '../scenario/index.ts';

export type InvariantResult = {
  name: string;
  ok: boolean;
  value: string; // what the query returned, for the report
  error?: string; // the query itself failed (a broken scenario, not a race)
};

export async function checkInvariants(client: pg.Client, invariants: readonly Invariant[]): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  for (const inv of invariants) {
    try {
      const res = await client.query({ text: inv.sql, rowMode: 'array' });
      const single = res.rows.length === 1 && res.fields.length === 1;
      const value: unknown = single ? (res.rows[0] as unknown[])[0] : undefined;
      results.push({
        name: inv.name,
        ok: single && value === true,
        value: single ? String(value) : `${res.rows.length} rows x ${res.fields.length} columns`,
      });
    } catch (err) {
      results.push({ name: inv.name, ok: false, value: '', error: (err as Error).message });
    }
  }
  return results;
}

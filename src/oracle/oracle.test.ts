import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AdminDb } from '../reset/index.ts';
import { checkInvariants } from './index.ts';
import { onCleanup } from '../testutil/cleanup.ts';

const DSN = process.env['INTERLEAVE_TEST_DSN'] ?? 'postgres://interleave:interleave@127.0.0.1:5432/interleave?sslmode=disable';

// admin connects to the interleave database, or skips the test if Postgres is down.
async function admin(t: TestContext): Promise<AdminDb | undefined> {
  try {
    const db = await AdminDb.connect(DSN);
    onCleanup(t, () => db.close());
    return db;
  } catch (err) {
    t.skip(`Postgres not reachable: ${(err as Error).message}`);
    return undefined;
  }
}

// This test's own table, so it cannot collide with the victims' tables.
const RESET = 'CREATE TABLE IF NOT EXISTS oracle_selftest (n int); TRUNCATE oracle_selftest; INSERT INTO oracle_selftest VALUES (1);';

test('ResetRunsSeveralStatements', async (t) => {
  const db = await admin(t);
  if (!db) return;
  onCleanup(t, () => db.client.query('DROP TABLE IF EXISTS oracle_selftest'));
  await db.client.query('CREATE TABLE IF NOT EXISTS oracle_selftest (n int); INSERT INTO oracle_selftest VALUES (5), (6);');
  const ms = await db.reset(RESET);
  assert.ok(ms >= 0);
  const { rows } = await db.client.query<{ n: number }>('SELECT n FROM oracle_selftest');
  assert.deepEqual(rows, [{ n: 1 }], 'reset must leave exactly the seeded rows');
});

test('InvariantHoldsOnlyForASingleTrue', async (t) => {
  const db = await admin(t);
  if (!db) return;
  onCleanup(t, () => db.client.query('DROP TABLE IF EXISTS oracle_selftest'));
  await db.reset(RESET);
  const results = await checkInvariants(db.client, [
    { name: 'holds', sql: 'SELECT n = 1 FROM oracle_selftest' },
    { name: 'false', sql: 'SELECT n = 2 FROM oracle_selftest' },
    { name: 'not a boolean', sql: 'SELECT n FROM oracle_selftest' },
    { name: 'NULL', sql: 'SELECT NULL::boolean' },
    { name: 'no row', sql: 'SELECT true FROM oracle_selftest WHERE n = 99' },
    { name: 'two columns', sql: 'SELECT true, true' },
    { name: 'broken SQL', sql: 'SELECT nope FROM oracle_selftest' },
  ]);
  assert.deepEqual(
    results.map((r) => `${r.name}: ${r.ok} ${r.value}${r.error === undefined ? '' : ' error'}`),
    [
      'holds: true true',
      'false: false false',
      'not a boolean: false 1',
      'NULL: false null',
      'no row: false 0 rows x 1 columns',
      'two columns: false 1 rows x 2 columns',
      'broken SQL: false  error',
    ],
  );
});

test('ResetReportsBadSQL', async (t) => {
  const db = await admin(t);
  if (!db) return;
  await assert.rejects(db.reset('SELECT * FROM no_such_table_here'), /reset SQL failed/);
});

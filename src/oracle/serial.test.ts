// Spec for the serial-equivalence oracle (D-031).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AdminDb } from '../reset/index.ts';
import { SerialOracle, serialOrders, snapshot, type Outcome } from './index.ts';
import { onCleanup } from '../testutil/cleanup.ts';

const DSN = process.env['INTERLEAVE_TEST_DSN'] ?? 'postgres://interleave:interleave@127.0.0.1:5432/interleave?sslmode=disable';

test('SerialOrdersAreEveryPermutation', () => {
  assert.deepEqual(serialOrders(['A']), [['A']]);
  assert.deepEqual(serialOrders(['A', 'B']), [
    ['A', 'B'],
    ['B', 'A'],
  ]);
  const three = serialOrders(['A', 'B', 'C']);
  assert.equal(three.length, 6);
  assert.equal(new Set(three.map((o) => o.join(''))).size, 6, 'no order twice');
  assert.deepEqual(three[0], ['A', 'B', 'C'], 'in request order first');
});

test('SnapshotKeepsListedColumnsInSortedRows', async (t) => {
  let db: AdminDb;
  try {
    db = await AdminDb.connect(DSN);
  } catch (err) {
    t.skip(`Postgres not reachable: ${(err as Error).message}`);
    return;
  }
  onCleanup(t, () => db.close());
  onCleanup(t, () => db.client.query('DROP TABLE IF EXISTS serial_selftest'));
  await db.client.query(
    "CREATE TABLE IF NOT EXISTS serial_selftest (id serial, k text, n int); TRUNCATE serial_selftest; INSERT INTO serial_selftest (k, n) VALUES ('b', 2), ('a', 9), ('a', 1);",
  );
  // id is not listed: a run that inserted the same rows in another order
  // (different ids) must give the same snapshot.
  const snap = await snapshot(db.client, [{ table: 'serial_selftest', columns: ['k', 'n'] }]);
  assert.deepEqual(snap, {
    serial_selftest: [
      ['a', 1],
      ['a', 9],
      ['b', 2],
    ],
  });
  await assert.rejects(snapshot(db.client, [{ table: 'serial_selftest', columns: ['missing'] }]), /serial_selftest/);
});

test('OracleMatchesAnyRecordedOrder', () => {
  const outcome = (uses: number, a: number, b: number): Outcome => ({ tables: { coupons: [['X', uses]] }, statuses: { A: a, B: b } });
  const oracle = new SerialOracle();
  oracle.record(['A', 'B'], outcome(1, 200, 409));
  oracle.record(['B', 'A'], outcome(1, 409, 200));
  assert.deepEqual(oracle.match(outcome(1, 200, 409)), ['A', 'B']);
  assert.deepEqual(oracle.match(outcome(1, 409, 200)), ['B', 'A']);
  assert.equal(oracle.match(outcome(2, 200, 200)), undefined, 'the double redeem matches no one-at-a-time order');
  assert.equal(oracle.match(outcome(1, 200, 200)), undefined, 'statuses are part of the outcome');
  // The same outcome built with keys in another order still matches.
  assert.deepEqual(oracle.match({ statuses: { B: 409, A: 200 }, tables: { coupons: [['X', 1]] } }), ['A', 'B']);
  assert.equal(oracle.outcomes.length, 2);
});

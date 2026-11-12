// Spec for the statement access classifier used by partial-order reduction
// (D-034): which tables a statement reads and writes, and whether two
// statements of different requests are independent (either order, same result).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, independent } from './access.ts';

test('ClassifiesStatements', () => {
  const cases: Array<[sql: string, want: ReturnType<typeof access>]> = [
    ['/* il:req=A */ BEGIN', { kind: 'begin', reads: [], writes: [] }],
    ['BEGIN ISOLATION LEVEL SERIALIZABLE', { kind: 'begin', reads: [], writes: [] }],
    ['/* il:req=A */ COMMIT', { kind: 'end', reads: [], writes: [] }],
    ['ROLLBACK', { kind: 'end', reads: [], writes: [] }],
    ["SELECT uses, max_uses FROM coupons WHERE code = 'X'", { kind: 'query', reads: ['coupons'], writes: [] }],
    ["SELECT code FROM coupons WHERE code = 'X' FOR UPDATE", { kind: 'query', reads: ['coupons'], writes: ['coupons'] }],
    ['SELECT id, balance FROM accounts WHERE id IN (1, 2) ORDER BY id FOR UPDATE', { kind: 'query', reads: ['accounts'], writes: ['accounts'] }],
    ['SELECT count(*)::int AS n FROM bookings WHERE seat = \'12A\'', { kind: 'query', reads: ['bookings'], writes: [] }],
    ['SELECT a.x FROM public.t1 a JOIN "T2" b ON a.id = b.id', { kind: 'query', reads: ['public.t1', 't2'], writes: [] }],
    ['SELECT 1', { kind: 'query', reads: [], writes: [] }],
    ["SELECT pg_advisory_xact_lock(hashtext('himanshu'))", { kind: 'query', reads: [], writes: ['pg_advisory'] }],
    ["UPDATE coupons SET uses = uses + 1 WHERE code = 'X'", { kind: 'query', reads: ['coupons'], writes: ['coupons'] }],
    ["INSERT INTO redemptions (code, user_id) VALUES ('X', 1)", { kind: 'query', reads: [], writes: ['redemptions'] }],
    ['INSERT INTO t (a) SELECT a FROM u', { kind: 'query', reads: ['u'], writes: ['t'] }],
    ['DELETE FROM t WHERE id = 1', { kind: 'query', reads: ['t'], writes: ['t'] }],
    // Anything not understood conflicts with everything.
    ['WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', { kind: 'unknown', reads: [], writes: [] }],
    ['SELECT f()', { kind: 'unknown', reads: [], writes: [] }],
    ['TRUNCATE t', { kind: 'unknown', reads: [], writes: [] }],
    ['UPDATE t SET a = 1; DELETE FROM u', { kind: 'unknown', reads: [], writes: [] }],
  ];
  for (const [sql, want] of cases) {
    assert.deepEqual(access(sql), want, sql);
  }
});

test('Independence', () => {
  const ok = (a: string, b: string) => independent(access(a), access(b));
  // Reads never conflict with reads.
  assert.equal(ok('SELECT x FROM coupons', 'SELECT y FROM coupons'), true);
  // A write conflicts with any access to the same table, in either order.
  assert.equal(ok('SELECT x FROM coupons', 'UPDATE coupons SET x = 1'), false);
  assert.equal(ok('UPDATE coupons SET x = 1', 'SELECT x FROM coupons'), false);
  assert.equal(ok('INSERT INTO redemptions (a) VALUES (1)', 'INSERT INTO redemptions (a) VALUES (2)'), false);
  // Different tables commute.
  assert.equal(ok('INSERT INTO redemptions (a) VALUES (1)', 'SELECT x FROM coupons'), true);
  // FOR UPDATE takes locks: it conflicts with another FOR UPDATE on the same table.
  assert.equal(ok('SELECT x FROM t FOR UPDATE', 'SELECT x FROM t FOR UPDATE'), false);
  // Advisory locks conflict with each other.
  assert.equal(ok("SELECT pg_advisory_xact_lock(hashtext('a'))", "SELECT pg_advisory_xact_lock(hashtext('b'))"), false);
  // BEGIN is independent of everything; COMMIT/ROLLBACK of everything except BEGIN and table-free statements.
  assert.equal(ok('BEGIN', 'UPDATE t SET a = 1'), true);
  assert.equal(ok('BEGIN', 'COMMIT'), true);
  assert.equal(ok('COMMIT', 'SELECT x FROM t'), false);
  assert.equal(ok('ROLLBACK', 'COMMIT'), false);
  assert.equal(ok('COMMIT', 'SELECT 1'), true);
  // Unknown statements conflict with everything, even BEGIN.
  assert.equal(ok('TRUNCATE t', 'BEGIN'), false);
  assert.equal(ok('SELECT 1', 'SELECT f()'), false);
});

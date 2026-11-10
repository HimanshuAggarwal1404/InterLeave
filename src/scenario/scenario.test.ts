import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenarioError, loadScenario } from './index.ts';

const valid = `
name: coupon-double-redeem
app:
  base_url: http://127.0.0.1:8081
database:
  admin_dsn: postgres://interleave:interleave@127.0.0.1:5432/interleave?sslmode=disable
  reset: seed.sql
requests:
  - method: POST
    path: /redeem
    body: {code: DIWALI50, user_id: 1}
  - method: POST
    path: /redeem
    body: {code: DIWALI50, user_id: 2}
invariants:
  - name: coupon not over-redeemed
    sql: SELECT uses <= max_uses FROM coupons WHERE code = 'DIWALI50'
`;

// withScenario writes a scenario (and a seed.sql next to it) to a temporary
// folder, loads it, and removes the folder again.
async function withScenario(yaml: string, seed: string | false = 'SELECT 1;'): Promise<ReturnType<typeof loadScenario>> {
  const dir = await mkdtemp(join(tmpdir(), 'interleave-scenario-'));
  try {
    const file = join(dir, 'scenario.yaml');
    await writeFile(file, yaml);
    if (seed !== false) {
      await writeFile(join(dir, 'seed.sql'), seed);
    }
    return await loadScenario(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('LoadsAValidScenario', async () => {
  const s = await withScenario(valid, 'TRUNCATE coupons;');
  assert.equal(s.name, 'coupon-double-redeem');
  assert.equal(s.baseUrl, 'http://127.0.0.1:8081');
  assert.equal(s.resetSql, 'TRUNCATE coupons;', 'reset is read from a path relative to the scenario file');
  assert.deepEqual(s.requests, [
    { tag: 'A', method: 'POST', path: '/redeem', body: { code: 'DIWALI50', user_id: 1 } },
    { tag: 'B', method: 'POST', path: '/redeem', body: { code: 'DIWALI50', user_id: 2 } },
  ]);
  assert.deepEqual(s.invariants, [{ name: 'coupon not over-redeemed', sql: "SELECT uses <= max_uses FROM coupons WHERE code = 'DIWALI50'" }]);
});

test('RejectsInvalidScenarios', async (t) => {
  // writeSeed false: no seed.sql next to the scenario.
  const cases: Array<[name: string, yaml: string, want: RegExp, writeSeed?: boolean]> = [
    ['not YAML', 'name: [unclosed', /YAML/],
    ['missing name', valid.replace('name: coupon-double-redeem', ''), /name/],
    ['name with spaces', valid.replace('name: coupon-double-redeem', 'name: two words'), /name/],
    ['remote app', valid.replace('http://127.0.0.1:8081', 'http://shop.example.com'), /base_url.*this machine/],
    ['remote database', valid.replace('@127.0.0.1:5432', '@db.example.com:5432'), /admin_dsn.*this machine/],
    ['no requests', valid.replace(/requests:[\s\S]*?invariants:/, 'requests: []\ninvariants:'), /requests/],
    ['bad method', valid.replace('method: POST', 'method: FETCH'), /method/],
    ['path without slash', valid.replace('path: /redeem', 'path: redeem'), /path/],
    ['no invariants', valid.replace(/invariants:[\s\S]*$/, 'invariants: []\n'), /invariants/],
    ['invariant without sql', valid.replace(/    sql: SELECT.*\n/, ''), /sql/],
    ['reset file missing', valid, /reset/, false],
  ];
  for (const [name, yaml, want, writeSeed = true] of cases) {
    await t.test(name, async () => {
      await assert.rejects(withScenario(yaml, writeSeed ? 'SELECT 1;' : false), (err: unknown) => {
        assert.ok(err instanceof ScenarioError, `want ScenarioError, got ${String(err)}`);
        assert.match(err.message, want);
        return true;
      });
    });
  }
});

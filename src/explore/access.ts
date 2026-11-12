// What a statement touches, for partial-order reduction (D-034). Two
// statements of different requests are independent when running them in
// either order gives the same result; then exploring both orders is wasted
// work. Deciding that exactly would need the database's internals, so this is
// a conservative reading of the SQL text at table level:
//   - reads/writes are table names (a write to a table conflicts with any
//     other access to it, whichever rows);
//   - BEGIN touches nothing (under READ COMMITTED and SERIALIZABLE alike the
//     snapshot is taken by the first query, not by BEGIN);
//   - COMMIT/ROLLBACK ('end') publish writes and release locks, so they
//     conflict with every statement that touches a table;
//   - FOR UPDATE/SHARE takes row locks: a write; advisory locks are writes to
//     one shared pseudo-table;
//   - anything not understood (CTEs, functions, several statements, DDL) is
//     'unknown' and conflicts with everything.
// Not visible from the SQL text, so not handled: triggers and rules that touch
// other tables. That is why reduction is opt-in (--por).

export type Access = {
  kind: 'begin' | 'end' | 'query' | 'unknown';
  reads: string[];
  writes: string[];
};

const ADVISORY = 'pg_advisory';
const NAME = String.raw`((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?)`;

function unknown(): Access {
  return { kind: 'unknown', reads: [], writes: [] };
}

// table normalises a name the way Postgres does: unquoted names fold to lower case.
function table(name: string): string {
  return name
    .split('.')
    .map((part) => (part.startsWith('"') ? part.slice(1, -1).toLowerCase() : part.toLowerCase()))
    .join('.');
}

function tablesAfter(sql: string, keyword: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(new RegExp(String.raw`\b${keyword}\s+${NAME}`, 'gi'))) {
    out.push(table(m[1]));
  }
  return out;
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();

export function access(sql: string): Access {
  // Drop the request tag and other leading comments, string literals (their
  // text must not look like SQL) and a trailing semicolon.
  const text = sql
    .replace(/^\s*(\/\*[\s\S]*?\*\/\s*)*/, '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim()
    .replace(/;\s*$/, '');
  if (text.includes(';')) {
    return unknown(); // several statements in one query
  }
  const first = (/^[A-Za-z]+/.exec(text)?.[0] ?? '').toUpperCase();
  if (first === 'BEGIN' || first === 'START') {
    return { kind: 'begin', reads: [], writes: [] };
  }
  if (first === 'COMMIT' || first === 'END' || first === 'ROLLBACK' || first === 'ABORT') {
    return { kind: 'end', reads: [], writes: [] };
  }
  const reads = [...tablesAfter(text, 'FROM'), ...tablesAfter(text, 'JOIN')];
  // Function calls other than a few harmless ones may do anything. (An
  // INSERT's column list, "INTO t (a, b)", is not a call: drop it first.)
  const scan = text.replace(new RegExp(String.raw`\bINTO\s+${NAME}\s*\([^)]*\)`, 'i'), 'INTO $1 ');
  const calls = [...scan.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1].toLowerCase());
  const harmless = new Set(['count', 'sum', 'min', 'max', 'avg', 'coalesce', 'hashtext', 'in', 'values', 'pg_advisory_xact_lock', 'pg_advisory_lock']);
  if (calls.some((c) => !harmless.has(c))) {
    return unknown();
  }
  const writes: string[] = [];
  if (calls.some((c) => c.startsWith('pg_advisory'))) {
    writes.push(ADVISORY);
  }
  switch (first) {
    case 'SELECT':
      if (/\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b/i.test(text)) {
        writes.push(...reads);
      }
      break;
    case 'INSERT': {
      const target = tablesAfter(text, 'INTO');
      if (target.length !== 1) {
        return unknown();
      }
      writes.push(target[0]);
      break;
    }
    case 'UPDATE': {
      const m = new RegExp(String.raw`^UPDATE\s+(?:ONLY\s+)?${NAME}`, 'i').exec(text);
      if (m === null) {
        return unknown();
      }
      writes.push(table(m[1]));
      reads.push(table(m[1])); // it reads the rows it changes
      break;
    }
    case 'DELETE': {
      const target = tablesAfter(text, 'FROM')[0];
      if (target === undefined) {
        return unknown();
      }
      writes.push(target);
      break;
    }
    default:
      return unknown(); // WITH, TRUNCATE, DDL, ...
  }
  return { kind: 'query', reads: uniq(reads), writes: uniq(writes) };
}

// independent reports whether running a and b (from different requests) in
// either order gives the same result.
export function independent(a: Access, b: Access): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown') {
    return false;
  }
  if (a.kind === 'begin' || b.kind === 'begin') {
    return true;
  }
  const touches = (x: Access) => x.reads.length + x.writes.length > 0;
  if (a.kind === 'end' || b.kind === 'end') {
    const other = a.kind === 'end' ? b : a;
    return other.kind === 'query' && !touches(other);
  }
  const overlap = (xs: string[], ys: string[]) => xs.some((x) => ys.includes(x));
  return !overlap(a.writes, [...b.reads, ...b.writes]) && !overlap(b.writes, a.reads);
}

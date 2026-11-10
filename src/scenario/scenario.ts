// Package scenario reads and checks a scenario file (SPEC section 4): which
// app to test, how to reset its database, which requests to fire at the same
// time, and which rules (invariants) must hold after every run.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { isLoopback } from '../proxy/index.ts';

export type ScenarioRequest = {
  tag: string; // A, B, ...: the request's name, sent as X-Interleave-Req
  method: string;
  path: string;
  body?: unknown; // sent as JSON
  headers?: Record<string, string>;
};

export type Invariant = { name: string; sql: string };

export type Scenario = {
  name: string;
  file: string; // absolute path of the scenario file
  baseUrl: string; // the app, e.g. http://127.0.0.1:8081
  adminDsn: string; // direct connection to Postgres for reset and invariants
  resetFile: string; // absolute path of the reset SQL
  resetSql: string;
  requests: ScenarioRequest[];
  invariants: Invariant[];
};

// ScenarioError is a problem with the scenario file itself (a usage error,
// exit code 2), with a message saying what to fix.
export class ScenarioError extends Error {
  override name = 'ScenarioError';
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_REQUESTS = 26; // tags A..Z

// loadScenario reads, parses and checks the scenario at path. The reset file
// is read too; its path is relative to the scenario file.
export async function loadScenario(path: string): Promise<Scenario> {
  const file = resolve(path);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new ScenarioError(`cannot read scenario ${path}: ${(err as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ScenarioError(`${path}: not valid YAML: ${(err as Error).message}`);
  }
  const s = checkScenario(doc, file);
  try {
    s.resetSql = await readFile(s.resetFile, 'utf8');
  } catch (err) {
    throw new ScenarioError(`${path}: database.reset: cannot read ${s.resetFile}: ${(err as Error).message}`);
  }
  return s;
}

// checkScenario turns the parsed YAML into a Scenario, checking every field.
function checkScenario(doc: unknown, file: string): Scenario {
  const fail = (what: string): never => {
    throw new ScenarioError(`${file}: ${what}`);
  };
  const root = record(doc) ?? fail('the file must be a mapping (name: ..., app: ..., ...)');

  const name = root['name'];
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    fail('name: want 1-64 of A-Z a-z 0-9 _ - (it is used in file names)');
  }

  const app = record(root['app']) ?? fail('app: missing (want app.base_url)');
  const baseUrl = app['base_url'];
  if (typeof baseUrl !== 'string' || !localUrl(baseUrl, ['http:'])) {
    fail('app.base_url: want an http:// URL on this machine (127.0.0.1, localhost or [::1])');
  }

  const db = record(root['database']) ?? fail('database: missing (want admin_dsn and reset)');
  const adminDsn = db['admin_dsn'];
  if (typeof adminDsn !== 'string' || !localUrl(adminDsn, ['postgres:', 'postgresql:'])) {
    fail('database.admin_dsn: want a postgres:// URL on this machine (127.0.0.1, localhost or [::1])');
  }
  const reset = db['reset'];
  if (typeof reset !== 'string' || reset === '') {
    fail('database.reset: want the path of the reset SQL file, relative to the scenario file');
  }

  const rawRequests = root['requests'];
  if (!Array.isArray(rawRequests) || rawRequests.length === 0 || rawRequests.length > MAX_REQUESTS) {
    fail(`requests: want a list of 1-${MAX_REQUESTS} requests`);
  }
  const requests = (rawRequests as unknown[]).map((raw, i) => {
    const r = record(raw) ?? fail(`requests[${i}]: want a mapping with method and path`);
    const method = typeof r['method'] === 'string' ? r['method'].toUpperCase() : '';
    if (!METHODS.includes(method)) {
      fail(`requests[${i}].method: want one of ${METHODS.join(', ')}`);
    }
    const path = r['path'];
    if (typeof path !== 'string' || !path.startsWith('/')) {
      fail(`requests[${i}].path: want a path starting with /`);
    }
    const req: ScenarioRequest = { tag: String.fromCharCode(65 + i), method, path: path as string };
    if (r['body'] !== undefined) {
      req.body = r['body'];
    }
    if (r['headers'] !== undefined) {
      const h = record(r['headers']) ?? fail(`requests[${i}].headers: want a mapping of header names to strings`);
      req.headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)]));
    }
    return req;
  });

  const rawInvariants = root['invariants'];
  if (!Array.isArray(rawInvariants) || rawInvariants.length === 0) {
    fail('invariants: want at least one {name, sql}');
  }
  const invariants = (rawInvariants as unknown[]).map((raw, i) => {
    const inv = record(raw) ?? fail(`invariants[${i}]: want a mapping with name and sql`);
    const invName = inv['name'];
    const sql = inv['sql'];
    if (typeof invName !== 'string' || invName === '') {
      fail(`invariants[${i}].name: missing`);
    }
    if (typeof sql !== 'string' || sql.trim() === '') {
      fail(`invariants[${i}].sql: missing (a query returning a single true when the rule holds)`);
    }
    return { name: invName as string, sql: sql as string };
  });

  return {
    name: name as string,
    file,
    baseUrl: (baseUrl as string).replace(/\/+$/, ''),
    adminDsn: adminDsn as string,
    resetFile: resolve(dirname(file), reset as string),
    resetSql: '',
    requests,
    invariants,
  };
}

// record returns v as an object of named fields, or undefined if it is not one.
function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// localUrl reports whether s is a URL with one of the protocols whose host is
// this machine. Interleave only ever talks to local apps and databases (D-012).
function localUrl(s: string, protocols: string[]): boolean {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // [::1] -> ::1
  return protocols.includes(url.protocol) && isLoopback(host);
}

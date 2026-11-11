// Package harness fires a scenario's HTTP requests at the app, all at the
// same time, each with its tag in the X-Interleave-Req header, and collects
// the responses (FR-7, FR-19).
import http from 'node:http';
import type { ScenarioRequest } from '../scenario/index.ts';

export type Response = {
  tag: string;
  status: number; // 0 if no response arrived
  body: string;
  error?: string; // the request failed (app not reachable, aborted, timed out)
};

export type FireOptions = {
  // finished is called as soon as a request's response (or error) is in:
  // the scheduler uses it to know the request is no longer running.
  finished?: (tag: string) => void;
  signal?: AbortSignal; // aborts every request still in flight
  timeoutMs?: number; // per request; default 30 s
};

// fireRequests sends every request at once and resolves with all responses,
// in request order. It never rejects: a failed request has `error` set.
export function fireRequests(baseUrl: string, requests: readonly ScenarioRequest[], options: FireOptions = {}): Promise<Response[]> {
  // All requests are started in this one synchronous loop, so none of them
  // can begin before the others are on their way.
  return Promise.all(requests.map((r) => fireOne(baseUrl, r, options)));
}

function fireOne(baseUrl: string, r: ScenarioRequest, options: FireOptions): Promise<Response> {
  const body = r.body === undefined ? undefined : JSON.stringify(r.body);
  // Header names are case-insensitive, so they are compared in lowercase: a
  // scenario's own content-type wins over the default, while the tag and the
  // length always come from here.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(r.headers ?? {})) {
    if (!['x-interleave-req', 'content-length'].includes(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  headers['X-Interleave-Req'] = r.tag;
  if (body !== undefined) {
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }
  return new Promise<Response>((resolve) => {
    let settled = false;
    const settle = (res: Response) => {
      if (!settled) {
        settled = true;
        resolve(res);
        options.finished?.(r.tag);
      }
    };
    // agent: false gives every request its own connection, closed afterwards,
    // so no idle connection outlives the run.
    const req = http.request(`${baseUrl}${r.path}`, {
      method: r.method,
      headers,
      agent: false,
      signal: options.signal,
      timeout: options.timeoutMs ?? 30_000,
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => settle({ tag: r.tag, status: 0, body: '', error: err.message }));
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => settle({ tag: r.tag, status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => settle({ tag: r.tag, status: res.statusCode ?? 0, body: '', error: err.message }));
    });
    req.end(body);
  });
}

// bench measures how many requests per second the coupon victim app serves,
// to compare the app talking to Postgres directly with the app going through
// the Interleave proxy (pass-through overhead, NFR-3).
//
// Usage: node src/bench/main.ts [flags] [URL ...]  (default URL: http://127.0.0.1:8081/redeem)
//
// It is a closed-loop load generator: each of --workers workers sends
// POST /redeem, waits for the response, and immediately sends the next one,
// for --duration. Each target gets a warmup round that is thrown away (it fills
// the app's connection pool and the HTTP keep-alive connections). Then --rounds
// measured rounds run, and in each round every target is measured once, in
// alternating order (A B, then B A, ...), so that a laptop slowing down as it
// heats up affects all targets alike. Use an even --rounds for a fair split.
//
// After seed.sql the coupon is single-use, so the first request redeems it and
// every measured request takes the "used up" path (409): BEGIN, SELECT,
// ROLLBACK. That is 3 round trips per request with no row locks, so requests do
// not queue behind each other and any extra latency from the proxy shows up.
//
// The workers are async loops in one Node process (one thread), so the bench
// itself can become the bottleneck at very high rates; every target shares
// that limit, so targets in one run stay comparable.
import http from 'node:http';
import { parseArgs } from 'node:util';

export type Config = {
  url: string;
  code: string;
  workers: number;
  warmupMs: number;
  durationMs: number;
  rounds: number;
};

// RoundResult is what one round measured. Each worker fills its own
// RoundResult and they are merged after the round.
export type RoundResult = {
  requests: number;
  errors: number; // transport failures and 5xx responses
  firstErr: string | undefined;
  statuses: Map<number, number>; // HTTP status code -> count
  latencies: number[]; // milliseconds; sorted after the merge
  elapsedMs: number;
};

// newAgent returns an HTTP agent that keeps one connection per worker open.
// Without keep-alive every request would open a new TCP connection, which
// measures TCP setup instead of the app and on Windows can run out of local ports.
export function newAgent(workers: number): http.Agent {
  return new http.Agent({ keepAlive: true, maxSockets: workers, maxFreeSockets: workers });
}

// runRound runs cfg.workers workers for durationMs and merges what they
// measured. A worker only checks the deadline before starting a request, so
// requests in flight at the deadline finish normally and are counted;
// elapsedMs covers them.
export async function runRound(agent: http.Agent, cfg: Config, durationMs: number, signal?: AbortSignal): Promise<RoundResult> {
  const start = performance.now();
  const deadline = start + durationMs;
  const worker = async (userId: number): Promise<RoundResult> => {
    const res = emptyResult();
    while (!signal?.aborted && performance.now() < deadline) {
      const t0 = performance.now();
      let status: number | undefined;
      let err: string | undefined;
      try {
        status = await send(agent, cfg, userId, signal);
      } catch (e) {
        if (signal?.aborted) {
          return res; // Ctrl+C, not a failure of the app
        }
        err = e instanceof Error ? e.message : String(e);
      }
      res.latencies.push(performance.now() - t0);
      res.requests++;
      if (status === undefined || status >= 500) {
        res.errors++;
        res.firstErr ??= err ?? `HTTP ${status}`;
      }
      if (status !== undefined) {
        res.statuses.set(status, (res.statuses.get(status) ?? 0) + 1);
      }
    }
    return res;
  };
  const results = await Promise.all(Array.from({ length: cfg.workers }, (_, w) => worker(w + 1)));

  const total = emptyResult();
  total.elapsedMs = performance.now() - start;
  for (const r of results) {
    total.requests += r.requests;
    total.errors += r.errors;
    total.firstErr ??= r.firstErr;
    for (const [s, n] of r.statuses) {
      total.statuses.set(s, (total.statuses.get(s) ?? 0) + n);
    }
    total.latencies.push(...r.latencies);
  }
  total.latencies.sort((a, b) => a - b);
  return total;
}

function emptyResult(): RoundResult {
  return { requests: 0, errors: 0, firstErr: undefined, statuses: new Map(), latencies: [], elapsedMs: 0 };
}

// send does one POST /redeem and returns the HTTP status code.
export function send(agent: http.Agent, cfg: Config, userId: number, signal?: AbortSignal): Promise<number> {
  const body = JSON.stringify({ code: cfg.code, user_id: userId });
  return new Promise((resolve, reject) => {
    const req = http.request(cfg.url, {
      method: 'POST',
      agent,
      signal,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('timeout', () => req.destroy(new Error('request timed out after 30s')));
    req.on('error', reject);
    req.on('response', (res) => {
      // Reading the body to the end lets the agent reuse the connection.
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    req.end(body);
  });
}

export function rate(r: RoundResult): number {
  return r.elapsedMs <= 0 ? 0 : r.requests / (r.elapsedMs / 1000);
}

export function formatRound(r: RoundResult): string {
  const statuses = [...r.statuses.keys()]
    .sort((a, b) => a - b)
    .map((s) => ` ${s}:${r.statuses.get(s)}`)
    .join('');
  return (
    `${String(r.requests).padStart(7)} requests in ${(r.elapsedMs / 1000).toFixed(2).padStart(5)}s = ` +
    `${rate(r).toFixed(1).padStart(8)} req/s  ` +
    `p50 ${formatDuration(percentile(r.latencies, 0.5)).padEnd(9)} ` +
    `p99 ${formatDuration(percentile(r.latencies, 0.99)).padEnd(9)} ` +
    `errors ${r.errors}  [status${statuses}]`
  );
}

// roundOrder returns the order in which to measure n targets in round
// (1-based): forwards in odd rounds, backwards in even ones.
export function roundOrder(round: number, n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  return round % 2 === 0 ? order.reverse() : order;
}

// percentile returns the nearest-rank p-th percentile (0 < p <= 1) of an
// already sorted array: the smallest value that at least p of the samples are
// less than or equal to.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  // The small epsilon stops float error (0.9*10 = 9.000000000000002) from
  // pushing the rank one too high.
  const rank = Math.ceil(p * sorted.length - 1e-9);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };

// parseDuration reads a duration the way Go's flag package does ("3s",
// "100ms", "1m30s", "2.5s") and returns milliseconds. It throws on anything else.
export function parseDuration(text: string): number {
  if (text === '0') {
    return 0;
  }
  const parts = [...text.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/g)];
  if (parts.length === 0 || parts.map((m) => m[0]).join('') !== text) {
    throw new Error(`invalid duration ${JSON.stringify(text)} (examples: 10s, 500ms, 1m30s)`);
  }
  return parts.reduce((ms, m) => ms + Number(m[1]) * UNIT_MS[m[2]], 0);
}

// formatDuration prints milliseconds rounded to the microsecond, like Go's
// Duration.String after Round(time.Microsecond): 577µs, 1.259ms, 10s, 1m30s.
export function formatDuration(ms: number): string {
  const us = Math.round(ms * 1000);
  if (us === 0) {
    return '0s';
  }
  if (us < 1000) {
    return `${us}µs`;
  }
  if (us < 1_000_000) {
    return `${trimZeros((us / 1000).toFixed(3))}ms`;
  }
  const minutes = Math.floor(us / 60_000_000);
  const seconds = `${trimZeros(((us % 60_000_000) / 1_000_000).toFixed(6))}s`;
  return minutes > 0 ? `${minutes}m${seconds}` : seconds;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

type Target = { name: string; cfg: Config; agent: http.Agent; rates: number[]; errors: number };

// run is the bench command. It returns the exit code: 0 ok, 1 errors or no
// complete rounds, 2 bad flags.
export async function run(argv: string[], signal?: AbortSignal): Promise<number> {
  let cfg: Omit<Config, 'url'>;
  let urls: string[];
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        code: { type: 'string', default: 'DIWALI50' },
        workers: { type: 'string', default: '16' },
        warmup: { type: 'string', default: '3s' },
        duration: { type: 'string', default: '10s' },
        rounds: { type: 'string', default: '3' },
      },
    });
    cfg = {
      code: values.code,
      workers: Number(values.workers),
      warmupMs: parseDuration(values.warmup),
      durationMs: parseDuration(values.duration),
      rounds: Number(values.rounds),
    };
    urls = positionals.length > 0 ? positionals : ['http://127.0.0.1:8081/redeem'];
  } catch (err) {
    console.error(`bench: ${err instanceof Error ? err.message : String(err)}`);
    console.error('usage: bench [--code C] [--workers N] [--warmup D] [--duration D] [--rounds N] [URL ...]');
    return 2;
  }
  if (!Number.isInteger(cfg.workers) || cfg.workers < 1 || !Number.isInteger(cfg.rounds) || cfg.rounds < 1 || cfg.durationMs <= 0) {
    console.error('bench: --workers and --rounds must be integers >= 1 and --duration > 0');
    return 2;
  }
  if (urls.length > 26) {
    console.error('bench: at most 26 URLs');
    return 2;
  }

  // Ctrl+C aborts stop: workers stop and we print whatever was measured.
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once('SIGINT', onStop);
  signal?.addEventListener('abort', onStop, { once: true });
  const targets: Target[] = urls.map((url, i) => ({
    name: String.fromCharCode(65 + i), // "A", "B", ...
    cfg: { ...cfg, url },
    agent: newAgent(cfg.workers),
    rates: [],
    errors: 0,
  }));
  try {
    console.log(`bench: ${cfg.workers} workers, warmup ${formatDuration(cfg.warmupMs)}, ${cfg.rounds} rounds x ${formatDuration(cfg.durationMs)}`);
    for (const tg of targets) {
      console.log(`  ${tg.name} = ${tg.cfg.url}`);
    }

    // One request to each target up front, so a missing app fails fast with a
    // clear message instead of a round full of "connection refused".
    for (const tg of targets) {
      let status: number;
      try {
        status = await send(tg.agent, tg.cfg, 0, stop.signal);
      } catch (err) {
        console.error(`bench: cannot reach the coupon app at ${tg.cfg.url}: ${err instanceof Error ? err.message : String(err)}\n(is it running?)`);
        return 1;
      }
      if (status >= 500) {
        console.error(`bench: ${tg.cfg.url} answered ${status}; check the app's terminal (is Postgres / the proxy up?)`);
        return 1;
      }
    }

    if (cfg.warmupMs > 0) {
      for (const tg of targets) {
        console.log(`warmup   ${tg.name}: ${formatRound(await runRound(tg.agent, tg.cfg, cfg.warmupMs, stop.signal))}`);
      }
    }
    for (let i = 1; i <= cfg.rounds && !stop.signal.aborted; i++) {
      for (const idx of roundOrder(i, targets.length)) {
        const tg = targets[idx];
        const r = await runRound(tg.agent, tg.cfg, cfg.durationMs, stop.signal);
        if (stop.signal.aborted) {
          break; // cut short by Ctrl+C: do not count a partial round
        }
        console.log(`round ${String(i).padEnd(2)} ${tg.name}: ${formatRound(r)}`);
        if (r.firstErr !== undefined) {
          console.log(`            first error: ${r.firstErr}`);
        }
        tg.rates.push(rate(r));
        tg.errors += r.errors;
      }
    }

    console.log();
    let totalErrors = 0;
    for (const tg of targets) {
      if (tg.rates.length === 0) {
        console.log(`result ${tg.name}: no complete rounds`);
        return 1;
      }
      console.log(
        `result ${tg.name}: median ${median(tg.rates).toFixed(1)} req/s (min ${Math.min(...tg.rates).toFixed(1)}, ` +
          `max ${Math.max(...tg.rates).toFixed(1)}) over ${tg.rates.length} rounds, ${tg.errors} errors`,
      );
      totalErrors += tg.errors;
    }
    for (const tg of targets.slice(1)) {
      const a = median(targets[0].rates);
      const change = ((median(tg.rates) - a) / a) * 100;
      console.log(`${tg.name} vs A: ${change >= 0 ? '+' : ''}${change.toFixed(1)}% req/s (medians)`);
    }
    if (totalErrors > 0) {
      console.log('WARNING: errors happened, so these numbers are not valid. Fix the setup and rerun.');
      return 1;
    }
    return 0;
  } finally {
    process.off('SIGINT', onStop);
    signal?.removeEventListener('abort', onStop);
    for (const tg of targets) {
      tg.agent.destroy(); // close the keep-alive connections, or the process would not exit
    }
  }
}

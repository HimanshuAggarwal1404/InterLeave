// Package reset: the admin connection that resets the database before every
// run (D-005, FR-17) and that the oracle uses to check invariants. It talks
// to Postgres directly, never through the proxy, so nothing it does is
// scheduled.
import pg from 'pg';

export class AdminDb {
  readonly client: pg.Client;

  private constructor(client: pg.Client) {
    this.client = client;
  }

  // connect opens the admin connection. lock_timeout makes a reset that
  // cannot get its locks fail after 5 s instead of waiting forever: that
  // happens if a transaction from the previous run is still open.
  static async connect(dsn: string): Promise<AdminDb> {
    const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 5000 });
    // A connection error after connecting (Postgres restarted) must not crash
    // the process; the next query reports it.
    client.on('error', () => {});
    await client.connect();
    await client.query("SET lock_timeout = '5s'; SET statement_timeout = '30s'");
    return new AdminDb(client);
  }

  // reset runs the scenario's reset SQL (several statements are fine: it is
  // sent as one simple query) and returns how long it took, in ms.
  async reset(sql: string): Promise<number> {
    const started = performance.now();
    try {
      await this.client.query(sql);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === '55P03') {
        throw new Error(
          'reset could not get a lock within 5 s: a transaction from the previous run is still open (is the app stuck?)',
          { cause: err },
        );
      }
      throw new Error(`reset SQL failed: ${e.message ?? String(err)}`, { cause: err });
    }
    return performance.now() - started;
  }

  // blockingPids asks Postgres which backends block the one with this PID,
  // i.e. hold a lock it is waiting for ([] = it is not waiting for a lock).
  // Lock-wait detection polls it while a statement runs (D-030); the admin
  // connection is idle during a run, so it is free for this.
  async blockingPids(pid: number): Promise<number[]> {
    if (!Number.isSafeInteger(pid)) {
      throw new Error(`not a backend PID: ${pid}`);
    }
    const res = await this.client.query<{ pids: number[] }>(`SELECT pg_blocking_pids(${pid}) AS pids`);
    return res.rows[0]?.pids ?? [];
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

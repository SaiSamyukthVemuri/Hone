import "server-only";
import type { RefreshCoordinator } from "./token-manager";

// Google Calendar — Phase B2.1: cross-process single-flight refresh via a
// transaction-scoped Postgres advisory lock.
//
// runExclusive opens a transaction on a pooled connection, takes
//   pg_advisory_xact_lock( hashtextextended('gcal_refresh:' || connectionId, 0) )
// then runs the callback (which performs the Google refresh + persist) while the
// lock is held, and COMMITs. The lock is released automatically at COMMIT/ROLLBACK
// — including on process death — so a crashed refresh never wedges a connection.
//
// The pool is typed STRUCTURALLY so this module adds no `pg` dependency to the
// application bundle: the worker wiring (B2.3+) and the DB integration tests pass
// a real node-postgres Pool; nothing in the deployed app imports `pg`.

export type PgQueryable = {
  query(text: string, params?: unknown[]): Promise<unknown>;
  release(): void;
};
export type PgPoolLike = {
  connect(): Promise<PgQueryable>;
};

// The lock key: a single bigint from hashtextextended over a namespaced string,
// so two different connection ids cannot collide onto the same advisory lock
// (64-bit hash; collision probability negligible) and this lock namespace cannot
// collide with any other advisory-lock use.
const LOCK_KEY_SQL =
  "select pg_advisory_xact_lock( hashtextextended('gcal_refresh:' || $1::text, 0) )";

export function createPgRefreshCoordinator(pool: PgPoolLike): RefreshCoordinator {
  return {
    async runExclusive<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(LOCK_KEY_SQL, [connectionId]);
        const result = await fn();
        await client.query("commit");
        return result;
      } catch (err) {
        try {
          await client.query("rollback");
        } catch {
          /* ignore rollback failure */
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

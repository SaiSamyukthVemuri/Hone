import "server-only";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { LockAcquire, ReconcileCoordinator, ReconcileLock } from "./reconcile";

// Google Calendar — Phase B2.3-b: a REAL cross-process, per-studio reconciliation
// lock backed by the Upstash Redis that already powers public rate limiting and
// the reminder heartbeat (no new infrastructure, no migration).
//
// WHY A DISTRIBUTED LOCK (and not pg advisory / an in-memory guard):
//   * The reconcile route runs on serverless Vercel functions through the
//     service-role PostgREST client — there is NO pooled Postgres connection held
//     across the sweep, so `pg_advisory_xact_lock` cannot span the protected work.
//     An in-memory mutex only guards a single process and two concurrent
//     invocations would both sweep. A Redis ownership-token lock is the correct
//     cross-process primitive here.
//
// OWNERSHIP-TOKEN SEMANTICS:
//   * acquire = SET key <token> NX EX ttl. "OK" => acquired; null => already held
//     by another sweep (skip that studio safely).
//   * release = a Lua compare-and-DELETE: only the holder of the exact token may
//     delete the key, so a slow sweep whose lease already expired can never delete
//     a lock a DIFFERENT sweep subsequently acquired.
//   * renew = a Lua compare-and-PEXPIRE: extend the lease only while still owned.
//
// FAIL-CLOSED (the critical distinction from the fail-OPEN heartbeat/metrics):
//   * If Upstash is unconfigured, unreachable, or throws on acquire, `acquire`
//     returns { ok:false, reason:'unavailable' }. The caller then SKIPS that
//     studio — it NEVER runs an unlocked sweep. A missing lock backend degrades to
//     "did not reconcile", never to "reconciled without mutual exclusion".
//   * A booking / appointment mutation is NEVER affected: the lock lives entirely
//     inside the reconcile cron path, not on any write path.
//
// NON-SENSITIVE: the lock key is derived solely from the studio id; the value is a
// random token. No client identity, appointment content, Google id, or secret is
// ever stored.

// The redis commands the lock + coordinator + continuation need — a tiny seam,
// trivially mockable. `get` supports the coordinator cursor read + the continuation
// read; `eval` runs the ownership-token Lua scripts (release/renew/atomic write).
export type LockRedis = {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts: { nx: true; ex: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
};

// Default TTL must safely exceed the processing time of a SINGLE page/batch; the
// sweep renews between pages, so a long studio never runs past the lease.
export const RECONCILE_LOCK_TTL_SECONDS = 120;

const KEY_PREFIX = "gcal_reconcile:lock:";

// Exported so the continuation store can reference the EXACT per-studio lock key in
// its atomic ownership-guarded write/clear (the Lua script checks this key's token).
export function reconcileLockKey(studioId: string): string {
  return `${KEY_PREFIX}${studioId}`;
}
// Back-compat local alias.
const lockKey = reconcileLockKey;

// Release: delete the key ONLY if it still holds our token.
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
// Renew: extend the TTL (ms) ONLY if we still own it.
const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

// Build a lock over an INJECTED redis-like client (used by tests to supply a mock
// or a throwing client). `newToken` is injectable for deterministic tests.
export function createReconcileLock(
  redis: LockRedis | null,
  opts: { ttlSeconds?: number; newToken?: () => string } = {},
): ReconcileLock {
  const ttlSeconds = Math.max(1, Math.floor(opts.ttlSeconds ?? RECONCILE_LOCK_TTL_SECONDS));
  const newToken = opts.newToken ?? (() => randomUUID());

  return {
    async acquire(studioId: string): Promise<LockAcquire> {
      // No backend configured -> fail-CLOSED (never sweep unlocked).
      if (!redis) return { ok: false, reason: "unavailable" };
      const token = newToken();
      try {
        const r = await redis.set(lockKey(studioId), token, { nx: true, ex: ttlSeconds });
        if (r === "OK") return { ok: true, token };
        return { ok: false, reason: "held" }; // null -> another sweep owns it
      } catch {
        // A backend error is NOT "free to proceed" — it is fail-closed.
        return { ok: false, reason: "unavailable" };
      }
    },

    async release(studioId: string, token: string): Promise<void> {
      if (!redis) return;
      try {
        await redis.eval(RELEASE_LUA, [lockKey(studioId)], [token]);
      } catch {
        // Best-effort: if release fails the TTL still expires the lease.
      }
    },

    async renew(studioId: string, token: string): Promise<boolean> {
      if (!redis) return false; // cannot confirm ownership -> stop paging (fail-closed)
      try {
        const r = await redis.eval(RENEW_LUA, [lockKey(studioId)], [token, ttlSeconds * 1000]);
        return r === 1 || r === "1"; // pexpire returned 1 => still owned + extended
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// §2 — the ROUTE COORDINATOR: a single global ownership-token lock + a durable
// global studio cursor. It serializes route invocations (so two invocations can
// never race the studio cursor) and remembers which studio was last attempted, so
// the sweep resumes AFTER it next time and every eligible studio eventually gets a
// turn even when every invocation hits its deadline. The per-studio locks remain
// the mutation-safety boundary; this lock only guards the global cursor + ordering.
// ---------------------------------------------------------------------------
export const RECONCILE_COORDINATOR_LOCK_KEY = "gcal_reconcile:coordinator:lock";
// The studio cursor is DURABLE correctness state (no expiry): the last-attempted
// immutable studio id. It is only ever written under the coordinator token.
export const RECONCILE_STUDIO_CURSOR_KEY = "gcal_reconcile:studio_cursor";

// Write the cursor ONLY while we still own the coordinator lock (atomic).
const CURSOR_WRITE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], ARGV[2]); return 1 else return 0 end";
const CURSOR_CLEAR_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[2]); return 1 else return 0 end";

export function createReconcileCoordinator(
  redis: LockRedis | null,
  opts: { ttlSeconds?: number; newToken?: () => string } = {},
): ReconcileCoordinator {
  const ttlSeconds = Math.max(1, Math.floor(opts.ttlSeconds ?? RECONCILE_LOCK_TTL_SECONDS));
  const newToken = opts.newToken ?? (() => randomUUID());
  const K = RECONCILE_COORDINATOR_LOCK_KEY;
  const C = RECONCILE_STUDIO_CURSOR_KEY;

  return {
    async acquire() {
      if (!redis) return { ok: false as const, reason: "unavailable" as const };
      const token = newToken();
      try {
        const r = await redis.set(K, token, { nx: true, ex: ttlSeconds });
        if (r === "OK") return { ok: true as const, token };
        return { ok: false as const, reason: "held" as const };
      } catch {
        return { ok: false as const, reason: "unavailable" as const };
      }
    },
    async release(token: string) {
      if (!redis) return;
      try {
        await redis.eval(RELEASE_LUA, [K], [token]);
      } catch {
        // Best-effort; the TTL expires the lease.
      }
    },
    async renew(token: string) {
      if (!redis) return false;
      try {
        const r = await redis.eval(RENEW_LUA, [K], [token, ttlSeconds * 1000]);
        return r === 1 || r === "1";
      } catch {
        return false;
      }
    },
    async readCursor() {
      // Plain read — the coordinator lock was just acquired.
      if (!redis) return { ok: false as const };
      try {
        const raw = await redis.get(C);
        return { ok: true as const, cursor: raw == null ? null : String(raw) };
      } catch {
        return { ok: false as const };
      }
    },
    async writeCursor(token: string, cursor: string | null) {
      // Token-guarded: advance/clear the cursor ONLY while we still own the lock.
      if (!redis) return false;
      try {
        if (cursor === null) {
          const r = await redis.eval(CURSOR_CLEAR_LUA, [K, C], [token]);
          return r === 1 || r === "1";
        }
        const r = await redis.eval(CURSOR_WRITE_LUA, [K, C], [token, cursor]);
        return r === 1 || r === "1";
      } catch {
        return false;
      }
    },
  };
}

function getLockRedis(): LockRedis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const client = new Redis({ url, token });
  return {
    get: (key) => client.get(key),
    set: (key, value, o) => client.set(key, value, o),
    eval: (script, keys, args) => client.eval(script, keys, args),
  };
}

// Production factory: binds the lock to the deployed Upstash. When Upstash is
// absent (e.g. local/dev without creds), the lock is fail-CLOSED and every studio
// is skipped — the reconcile route then reports "unavailable" and does no work.
export function createUpstashReconcileLock(): ReconcileLock {
  return createReconcileLock(getLockRedis());
}

export function createUpstashReconcileCoordinator(): ReconcileCoordinator {
  return createReconcileCoordinator(getLockRedis());
}

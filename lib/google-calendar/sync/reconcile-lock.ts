import "server-only";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { LockAcquire, ReconcileLock } from "./reconcile";

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

// Only the two commands the lock needs — keeps the seam tiny + trivially mockable.
export type LockRedis = {
  set(key: string, value: string, opts: { nx: true; ex: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
};

// Default TTL must safely exceed the processing time of a SINGLE page/batch; the
// sweep renews between pages, so a long studio never runs past the lease.
export const RECONCILE_LOCK_TTL_SECONDS = 120;

const KEY_PREFIX = "gcal_reconcile:lock:";

function lockKey(studioId: string): string {
  return `${KEY_PREFIX}${studioId}`;
}

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

function getLockRedis(): LockRedis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const client = new Redis({ url, token });
  return {
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

import "server-only";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { RefreshCoordinator } from "./token-manager";

// Google Calendar: Phase B2.3-c2: the PRODUCTION cross-process token-refresh
// mutex, backed by the Upstash Redis that already powers public rate limiting,
// the reminder heartbeat, and the B2.3-b reconciliation lock.
//
// WHY UPSTASH (architecture amendment, not a workaround):
//   The worker-drain route runs on serverless Vercel functions through the
//   service-role PostgREST client. There is NO pooled raw-Postgres connection
//   held across the refresh, so `pg_advisory_xact_lock` (createPgRefreshCoordinator)
//   cannot span the protected critical section without adding `pg` to the
//   production bundle, a raw-DB connection secret, and a new environment variable
//   none of which exist and none of which this phase is authorized to add. A
//   Redis ownership-token lock is the correct, already-deployed cross-process
//   primitive. This is the established production runtime, not a temporary hack.
//
// NARROW SCOPE: this is the existing RefreshCoordinator interface: a per-connection
// TOKEN-LIFECYCLE mutex, NOT a worker-route/queue/studio coordinator. Worker
// concurrency is owned entirely by claim_calendar_sync_op + FOR UPDATE SKIP LOCKED
// + claim tokens + lease expiry + the reaper. The only two Google Calendar
// orchestration coordinators remain reconciliation and dead-row alerting; this
// mutex is not a third one. Its ONLY protected callback is the token manager's
// refresh critical section (reload connection, load+decrypt refresh token, call
// Google refresh, persist a rotated refresh token, touch expiry, populate the
// process access-token cache).
//
// FAIL-CLOSED: a held lock, an unconfigured backend, or a thrown Redis error all
// prevent the callback from running (a safe typed throw). The token manager's
// existing `.catch()` converts that into its bounded `retry_transient`
// `refresh_lock_error`, so an uncoordinated refresh (which could race a rotated-
// token persist across processes) NEVER happens. There is no busy-wait and no
// retry loop inside runExclusive.
//
// NON-SENSITIVE: the key is derived solely from the connection id; the value is a
// random ownership token. NO access token, refresh token, OAuth/client secret,
// appointment/Google/calendar data, or CRON_SECRET is ever stored in Redis, and
// the connection id / raw Redis error is never logged or surfaced.

// The tiny redis seam the coordinator needs: trivially mockable in tests.
export type RefreshLockRedis = {
  set(key: string, value: string, opts: { nx: true; ex: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
};

// Fixed TTL. Safely exceeds both the whole worker-route budget and the single
// refresh critical section (a bounded ~10s Google refresh + encrypted-token +
// expiry persistence). NOT caller-controlled. Matches the reconcile lock's 120s.
export const GCAL_REFRESH_LOCK_TTL_SECONDS = 120;

const KEY_PREFIX = "gcal_refresh:lock:";

export function refreshLockKey(connectionId: string): string {
  return `${KEY_PREFIX}${connectionId}`;
}

// Release: delete the key ONLY if it still holds our exact token, so a slow holder
// whose lease already expired can never delete a DIFFERENT invocation's lock.
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// A safe, typed internal error. Carries NO connection id and NO raw Redis message
// (only a coarse reason), so nothing sensitive can leak if it is ever logged. The
// token manager converts any throw here into `refresh_lock_error` (transient).
export class RefreshLockUnavailableError extends Error {
  readonly reason: "unavailable" | "held";
  constructor(reason: "unavailable" | "held") {
    super(`refresh lock ${reason}`);
    this.name = "RefreshLockUnavailableError";
    this.reason = reason;
  }
}

// Build a coordinator over an INJECTED redis-like client (tests supply a mock or a
// throwing client). `newToken` is injectable for deterministic tests.
export function createRefreshCoordinator(
  redis: RefreshLockRedis | null,
  opts: { ttlSeconds?: number; newToken?: () => string } = {},
): RefreshCoordinator {
  const ttlSeconds = Math.max(1, Math.floor(opts.ttlSeconds ?? GCAL_REFRESH_LOCK_TTL_SECONDS));
  const newToken = opts.newToken ?? (() => randomUUID());

  return {
    async runExclusive<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
      // No backend configured -> fail-CLOSED (never refresh uncoordinated).
      if (!redis) throw new RefreshLockUnavailableError("unavailable");
      const key = refreshLockKey(connectionId);
      const token = newToken();

      // Atomic acquire: SET key token NX EX ttl. Only "OK" means acquired; a null
      // reply means another invocation holds it -> fail-closed (no busy-wait, no
      // retry loop). A thrown Redis error is NOT "free to proceed" -> fail-closed.
      let acquired = false;
      try {
        const r = await redis.set(key, token, { nx: true, ex: ttlSeconds });
        if (r !== "OK") throw new RefreshLockUnavailableError("held");
        acquired = true;
      } catch (err) {
        if (err instanceof RefreshLockUnavailableError) throw err;
        throw new RefreshLockUnavailableError("unavailable");
      }

      try {
        return await fn();
      } finally {
        // Best-effort ownership-safe release. If it fails, the TTL expires the lease.
        if (acquired) {
          try {
            await redis.eval(RELEASE_LUA, [key], [token]);
          } catch {
            // never let a release failure corrupt the completed callback result
          }
        }
      }
    },
  };
}

function getRefreshLockRedis(): RefreshLockRedis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const client = new Redis({ url, token });
  return {
    set: (key, value, o) => client.set(key, value, o),
    eval: (script, keys, args) => client.eval(script, keys, args),
  };
}

// PRODUCTION factory. Binds the coordinator to the deployed Upstash. When Upstash
// is absent (local/dev without creds), the coordinator is fail-CLOSED: every
// refresh reports the token manager's bounded `refresh_lock_error` transient
// rather than refreshing without cross-process mutual exclusion. Never falls back
// to inProcessOnlyCoordinator; never logs an env value.
export function createUpstashRefreshCoordinator(): RefreshCoordinator {
  return createRefreshCoordinator(getRefreshLockRedis());
}

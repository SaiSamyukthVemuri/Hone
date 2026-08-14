import "server-only";
import { Redis } from "@upstash/redis";
import { reconcileLockKey } from "./reconcile-lock";
import type { ReconcileContinuation, ReconcileContinuationStore } from "./reconcile";

// Google Calendar: Phase B2.3-b: durable, resumable pagination continuation for
// the reconciliation sweep, backed by the deployed Upstash. A truncated run (page
// budget, route deadline, or lost lease) persists WHERE it stopped so the next
// invocation resumes AFTER that immutable cursor: later appointments never starve.
//
// OWNERSHIP-ATOMIC (§3). Continuation write/clear are NOT plain SET/DEL. Each is a
// Lua script that verifies the per-studio LOCK key still holds the caller's exact
// ownership token and mutates the continuation ONLY while ownership matches. So a
// stale owner (whose lease expired and was re-acquired by a newer sweep) can neither
// overwrite nor clear the newer owner's continuation. The token is passed in.
//
// DURABLE, NO ARBITRARY EXPIRY. The continuation is CORRECTNESS state: it is written
// WITHOUT a TTL and removed only by an explicit ownership-atomic clear on completion.
// (A short TTL would let the record expire BETWEEN normal scheduled invocations and
// silently restart a large studio from the beginning: starvation.) A `schemaVersion`
// guards forward-compatibility; a mismatched/corrupt record reads as absent (safe,
// restarting under a fresh snapshot never false-completes, convergence is idempotent).
//
// FAIL-CLOSED read: { ok:false } is an I/O error (the caller must NOT sweep: position
// unknown); { ok:true, value:null } means "no continuation" (start fresh).
//
// The record holds ONLY non-sensitive position state (snapshot + activation + pass +
// immutable id). No client identity, appointment content, Google id, or token.

const CONT_PREFIX = "gcal_reconcile:cursor:";
const SCHEMA_VERSION = 1;

function contKey(studioId: string): string {
  return `${CONT_PREFIX}${studioId}`;
}

// KEYS[1] = per-studio lock key, KEYS[2] = continuation key, ARGV[1] = token,
// ARGV[2] = value. Write with NO expiry (durable). Clear returns owned regardless of
// key presence (a DEL of an absent key is still "cleared while owned").
const WRITE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], ARGV[2]); return 1 else return 0 end";
const CLEAR_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[2]); return 1 else return 0 end";

// Minimal redis seam (mockable). `get` for the read; `eval` for the atomic mutations.
export type ContinuationRedis = {
  get(key: string): Promise<unknown>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
};

function isValid(v: unknown): v is ReconcileContinuation {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.schemaVersion !== undefined && c.schemaVersion !== SCHEMA_VERSION) return false; // schema drift -> absent
  return (
    typeof c.snapshotStartedAtIso === "string" &&
    typeof c.activationStartedAtIso === "string" &&
    (c.pass === "appointments" || c.pass === "links") &&
    (c.cursor === null || typeof c.cursor === "string")
  );
}

export function createReconcileContinuationStore(redis: ContinuationRedis | null): ReconcileContinuationStore {
  return {
    async read(studioId: string) {
      if (!redis) return { ok: false as const }; // no backend -> position unknown -> fail-closed
      try {
        const raw = await redis.get(contKey(studioId));
        if (raw == null) return { ok: true as const, value: null };
        const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
        return { ok: true as const, value: isValid(parsed) ? parsed : null };
      } catch {
        return { ok: false as const };
      }
    },

    async write(studioId: string, ownerToken: string, value: ReconcileContinuation) {
      if (!redis) return false;
      try {
        const payload = JSON.stringify({ ...value, schemaVersion: SCHEMA_VERSION });
        const r = await redis.eval(WRITE_LUA, [reconcileLockKey(studioId), contKey(studioId)], [ownerToken, payload]);
        return r === 1 || r === "1"; // written while still owned
      } catch {
        return false;
      }
    },

    async clear(studioId: string, ownerToken: string) {
      if (!redis) return false;
      try {
        const r = await redis.eval(CLEAR_LUA, [reconcileLockKey(studioId), contKey(studioId)], [ownerToken]);
        return r === 1 || r === "1"; // cleared/absent while still owned
      } catch {
        return false;
      }
    },
  };
}

function getContinuationRedis(): ContinuationRedis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const client = new Redis({ url, token });
  return {
    get: (k) => client.get(k),
    eval: (script, keys, args) => client.eval(script, keys, args),
  };
}

// Production factory. When Upstash is absent, read() is fail-closed (every studio is
// skipped), so the reconcile route does no work rather than sweep from an unknown
// position.
export function createUpstashReconcileContinuationStore(): ReconcileContinuationStore {
  return createReconcileContinuationStore(getContinuationRedis());
}

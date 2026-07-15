import "server-only";
import { Redis } from "@upstash/redis";
import type { ReconcileContinuation, ReconcileContinuationStore } from "./reconcile";

// Google Calendar — Phase B2.3-b: durable, resumable pagination continuation for
// the reconciliation sweep, backed by the deployed Upstash. A truncated run (page
// budget, route deadline, or lost lease) persists WHERE it stopped so the next
// invocation resumes AFTER that immutable cursor — later appointments never starve
// behind already-converged early rows.
//
// CORRECTNESS STATE, FAIL-CLOSED:
//   * read() returning { ok:false } is an I/O error -> the caller must NOT sweep the
//     studio (it cannot know its position). It is NOT the same as an absent record.
//   * read() returning { ok:true, value:null } means "no continuation" -> start a
//     fresh pass under a new snapshot.
//   * A lost record can NEVER cause a studio to be reported complete: a missing
//     value restarts from the beginning under a fresh snapshot, and convergence is
//     idempotent, so re-scanning already-converged rows is safe (they classify as
//     converged/in-flight and are skipped). We never skip to the end.
//   * All writes happen UNDER the per-studio lock, so two sweeps cannot race the
//     continuation.
//
// The record holds ONLY non-sensitive position state: the pinned snapshot +
// activation timestamps, the pass/class, and the immutable last-seen id. No client
// identity, appointment content, Google id, or token.

const KEY_PREFIX = "gcal_reconcile:cursor:";
// Long enough to survive between bounded invocations of a large studio; a genuinely
// abandoned continuation expires and the studio restarts fresh (safe).
const TTL_SECONDS = 60 * 60 * 6; // 6h

function key(studioId: string): string {
  return `${KEY_PREFIX}${studioId}`;
}

// Minimal redis seam (mockable in tests).
export type ContinuationRedis = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts: { ex: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

function isValid(v: unknown): v is ReconcileContinuation {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
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
      // No backend -> cannot determine position -> FAIL-CLOSED (do not sweep).
      if (!redis) return { ok: false as const };
      try {
        const raw = await redis.get(key(studioId));
        if (raw == null) return { ok: true as const, value: null };
        const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
        // A corrupt/legacy record is treated as absent (start fresh) — safe, not
        // fail-closed, because restarting under a new snapshot never false-completes.
        return { ok: true as const, value: isValid(parsed) ? parsed : null };
      } catch {
        return { ok: false as const }; // I/O error -> fail-closed
      }
    },

    async write(studioId: string, value: ReconcileContinuation) {
      if (!redis) return false;
      try {
        await redis.set(key(studioId), value, { ex: TTL_SECONDS });
        return true;
      } catch {
        return false; // persist failed -> caller marks the studio degraded (not complete)
      }
    },

    async clear(studioId: string) {
      if (!redis) return false;
      try {
        await redis.del(key(studioId));
        return true;
      } catch {
        return false; // benign: a stale record resumes past the end, drains, clears again
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
    set: (k, v, o) => client.set(k, v, o),
    del: (k) => client.del(k),
  };
}

// Production factory. When Upstash is absent, read() is fail-closed (every studio
// is skipped), so the reconcile route does no work rather than sweep from an
// unknown position.
export function createUpstashReconcileContinuationStore(): ReconcileContinuationStore {
  return createReconcileContinuationStore(getContinuationRedis());
}

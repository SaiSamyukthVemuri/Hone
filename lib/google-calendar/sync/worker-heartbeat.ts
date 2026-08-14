import "server-only";
import { Redis } from "@upstash/redis";

// Google Calendar: Phase B2.3-c2: the worker-drain route heartbeat.
//
// SEPARATE from the reconciliation heartbeat (different key + different type): a
// single overwritten Upstash KV key recording the last worker-route run so an
// operator can see healthy / stale / missing without polling the queue. Reuses the
// Upstash Redis that already backs rate limiting + the reconcile route, no
// migration, no new dependency, no new scheduler.
//
// POSTURE: FAIL-OPEN. The write is best-effort and NEVER throws: a heartbeat
// failure must never alter claim/handle/record behaviour, change a JobResult,
// cause a retry or a second provider call, make a completed job look incomplete,
// hide a record failure, or change the HTTP response's core execution truth. The
// heartbeat is recorded only AFTER core execution has reached its truthful final
// result. An unauthorized request writes no heartbeat.
//
// NON-SENSITIVE ONLY: a timestamp + a coarse outcome + PHI-free aggregate counters.
// NEVER a studio/connection/practitioner/appointment/link/calendar/Google-event id,
// client identity, appointment time or content, OAuth/refresh token, CRON_SECRET,
// provider response body, or raw error message.

const HEARTBEAT_KEY = "gcal_worker:last_run";
// Expire well after a healthy cadence so a long-dead worker reads as "missing"
// rather than leaving an ancient timestamp lingering forever.
const HEARTBEAT_TTL_SECONDS = 60 * 60 * 24; // 24h

export type WorkerHeartbeat = {
  at: string; // ISO timestamp of the last completed run
  started_at?: string;
  duration_ms?: number;
  outcome?: "ok" | "degraded" | "error";
  no_work?: boolean;
  claimed?: number;
  handled?: number;
  recorded_done?: number;
  recorded_pending?: number;
  recorded_dead?: number;
  record_idempotent?: number;
  record_rejected?: number;
  record_errors?: number;
  unstarted_claimed?: number;
  timed_out?: boolean;
  // Coarse safe error class (never a raw message); present only on a failed run.
  error_class?: string | null;
  // Aggregate handler-result-code counts (closed enum codes only, never PHI).
  by_code?: Record<string, number>;
};

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

// Best-effort, fail-open. Called by the worker route AFTER a run reaches its
// truthful final result. Never throws.
export async function recordWorkerRun(heartbeat: WorkerHeartbeat): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(HEARTBEAT_KEY, heartbeat, { ex: HEARTBEAT_TTL_SECONDS });
  } catch {
    // A heartbeat write must never break the worker run.
  }
}

// Read the last worker heartbeat for an operator surface. Returns null when
// Upstash is unconfigured/unreachable or no run has been recorded.
export async function readWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get<WorkerHeartbeat | string>(HEARTBEAT_KEY);
    if (!raw) return null;
    const hb = typeof raw === "string" ? (JSON.parse(raw) as WorkerHeartbeat) : raw;
    return hb && typeof hb.at === "string" ? hb : null;
  } catch {
    return null;
  }
}

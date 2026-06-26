import "server-only";
import { Redis } from "@upstash/redis";
import { CRON_INTERVAL_MINUTES } from "@/lib/cron/reminder-schedule";

// ---------------------------------------------------------------------------
// PR #265. Operator-visible heartbeat for the EXTERNAL appointment-reminder
// scheduler.
// ---------------------------------------------------------------------------
//
// /api/cron/appointment-reminders is driven by an external every-15-minute
// scheduler (cron-job.org), because Vercel's plan caps cron at once-per-day
// (PR #258). If that external scheduler is disabled, misconfigured, or
// failing, reminders silently stop and NOTHING is recorded — a stopped
// scheduler produces SILENCE, not an alert (the existing
// `cron_route_failed` / `reminder_send_exhausted` ops_alerts only fire when
// the route runs AND something throws/exhausts).
//
// This module records a single positive "last successful reminder cron run"
// heartbeat so the admin console can show healthy / stale / missing. It
// reuses the Upstash Redis that already backs public rate limiting
// (PR #262 makes it production-required) — a single overwritten KV key, NOT
// the append-only ops_alerts table (which would gain ~96 info rows/day and
// pollute the failure dashboard). No migration, no new dependency, no new
// scheduler/queue.
//
// Posture (mirrors lib/rate-limit/public.ts): FAIL-OPEN. The write is
// best-effort and never throws — a heartbeat failure must never break a real
// reminder run. The read returns null ("unknown/unconfigured") on any error
// rather than crashing the admin page. Locally (no Upstash) it reads as
// missing/unknown, which is acceptable for an operator signal; in production
// Upstash is guaranteed present by the PR #262 build gate.
//
// Non-sensitive ONLY: the heartbeat stores a timestamp + aggregate run
// counts. NEVER a client email/phone/name, appointment notes, raw token,
// token hash, URL, or the CRON_SECRET.

const HEARTBEAT_KEY = "reminder_cron:last_success";
// Expire the key well after a healthy cadence so a long-dead scheduler reads
// as "missing" rather than leaving an ancient timestamp lingering forever.
const HEARTBEAT_TTL_SECONDS = 60 * 60 * 24; // 24h

// Staleness threshold = 3 missed */15 cycles. Derived from the shared cadence
// constant so the two can never drift.
export const REMINDER_STALE_AFTER_MINUTES = CRON_INTERVAL_MINUTES * 3; // 45

export type ReminderHeartbeat = {
  at: string; // ISO timestamp of the last successful run
  durationMs?: number;
  emailAttempted?: number;
  emailSucceeded?: number;
  emailFailed?: number;
  smsAttempted?: number;
  smsSucceeded?: number;
  smsFailed?: number;
};

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

// Best-effort, fail-open. Called by the cron route after a successful run.
export async function recordReminderRunSuccess(
  heartbeat: ReminderHeartbeat,
): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(HEARTBEAT_KEY, heartbeat, { ex: HEARTBEAT_TTL_SECONDS });
  } catch {
    // A heartbeat write must never break the reminder run.
  }
}

// Read the last-success heartbeat for the admin console. Returns null when
// Upstash is unconfigured/unreachable or no run has been recorded.
export async function readReminderHeartbeat(): Promise<ReminderHeartbeat | null> {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get<ReminderHeartbeat | string>(HEARTBEAT_KEY);
    if (!raw) return null;
    // The Upstash client usually deserializes JSON; tolerate a string too.
    const hb = typeof raw === "string" ? (JSON.parse(raw) as ReminderHeartbeat) : raw;
    return hb && typeof hb.at === "string" ? hb : null;
  } catch {
    return null;
  }
}

export type ReminderSchedulerStatus = {
  status: "healthy" | "stale" | "missing";
  lastSuccessAt: string | null;
  ageMinutes: number | null;
  cadenceMinutes: number;
  staleAfterMinutes: number;
};

// Pure, deterministic classifier — the testable core. `nowMs` is injected so
// tests are time-independent.
//   healthy: last success within REMINDER_STALE_AFTER_MINUTES
//   stale:   last success older than that
//   missing: no (valid) heartbeat recorded
export function computeReminderSchedulerStatus(
  heartbeat: ReminderHeartbeat | null,
  nowMs: number,
): ReminderSchedulerStatus {
  const base = {
    cadenceMinutes: CRON_INTERVAL_MINUTES,
    staleAfterMinutes: REMINDER_STALE_AFTER_MINUTES,
  };
  const parsed = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  if (Number.isNaN(parsed)) {
    return { status: "missing", lastSuccessAt: null, ageMinutes: null, ...base };
  }
  const ageMinutes = Math.max(0, Math.round((nowMs - parsed) / 60000));
  return {
    status: ageMinutes <= REMINDER_STALE_AFTER_MINUTES ? "healthy" : "stale",
    lastSuccessAt: heartbeat!.at,
    ageMinutes,
    ...base,
  };
}

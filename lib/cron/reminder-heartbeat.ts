import "server-only";
import { Redis } from "@upstash/redis";
import { CRON_INTERVAL_MINUTES } from "@/lib/cron/reminder-schedule";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";

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

// ---------------------------------------------------------------------------
// Health thresholds — derived from the shipped cadence contract, never literals
// ---------------------------------------------------------------------------
//
// Both thresholds are multiples of CRON_INTERVAL_MINUTES so a future cadence
// change moves the monitoring contract with it (there is no second magic 15).
//
// DEGRADED (2 x cadence = 30 min). This is the exact point where the reminder
// system loses its correctness MARGIN, and the number is not arbitrary: the 2h
// reminder window is 30 minutes wide (REMINDER_WINDOW_MINUTES["2h"] = [105,
// 135]). The reliability invariant in lib/cron/reminder-schedule.ts is that a
// window W minutes wide sampled every P minutes is only missable when W < P.
// So while the effective cadence stays <= 30 the 2h window still covers every
// appointment minute offset; the moment it exceeds 30, appointment offsets
// start being missed outright (at 45 min: 19/60 offsets; at 60 min: 29/60).
// A heartbeat age above 2 x cadence therefore means "the external scheduler is
// no longer delivering the cadence the window math depends on".
//
// STALE (3 x cadence = 45 min) is unchanged from PR #265 — three consecutive
// missed cycles is a sustained failure, not a blip, and matches the 3-strike
// per-row MAX_ATTEMPTS posture of the reminder route itself.
//
// PR #283 classified everything from 45 min upwards as one "stale" bucket and
// reported it as a WARNING, which never emails. That left two holes this module
// now closes: ages between 30 and 45 minutes were reported as fully "healthy"
// (a silent cadence regression), and a genuinely dead scheduler only produced
// an EMAIL once the 24h heartbeat TTL expired it into "missing" — up to ~48h.
export const REMINDER_DEGRADED_AFTER_MINUTES = CRON_INTERVAL_MINUTES * 2; // 30
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

export type ReminderSchedulerHealth =
  | "healthy"
  | "degraded"
  | "stale"
  | "missing";

export type ReminderSchedulerStatus = {
  status: ReminderSchedulerHealth;
  lastSuccessAt: string | null;
  ageMinutes: number | null;
  cadenceMinutes: number;
  degradedAfterMinutes: number;
  staleAfterMinutes: number;
};

// Pure, deterministic classifier — the testable core. `nowMs` is injected so
// tests are time-independent.
//   healthy:  last success within REMINDER_DEGRADED_AFTER_MINUTES (2x cadence)
//   degraded: older than that but within REMINDER_STALE_AFTER_MINUTES — the
//             cadence margin the 2h reminder window depends on is gone
//   stale:    older than REMINDER_STALE_AFTER_MINUTES (3 missed cycles)
//   missing:  no (valid) heartbeat recorded
export function computeReminderSchedulerStatus(
  heartbeat: ReminderHeartbeat | null,
  nowMs: number,
): ReminderSchedulerStatus {
  const base = {
    cadenceMinutes: CRON_INTERVAL_MINUTES,
    degradedAfterMinutes: REMINDER_DEGRADED_AFTER_MINUTES,
    staleAfterMinutes: REMINDER_STALE_AFTER_MINUTES,
  };
  const parsed = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  if (Number.isNaN(parsed)) {
    return { status: "missing", lastSuccessAt: null, ageMinutes: null, ...base };
  }
  const ageMinutes = Math.max(0, Math.round((nowMs - parsed) / 60000));
  const status: ReminderSchedulerHealth =
    ageMinutes <= REMINDER_DEGRADED_AFTER_MINUTES
      ? "healthy"
      : ageMinutes <= REMINDER_STALE_AFTER_MINUTES
        ? "degraded"
        : "stale";
  return {
    status,
    lastSuccessAt: heartbeat!.at,
    ageMinutes,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// PR #283. Deduped ops alert for a stale/missing reminder scheduler.
// ---------------------------------------------------------------------------
//
// PR #265 made the external-scheduler health observable (the admin
// "Reminder scheduler" card), but the signal stayed PASSIVE — an operator
// only learns the scheduler stopped if they happen to open /admin. This
// records an ops alert so a dead scheduler becomes actionable (and, for the
// missing case, emails OPS_ALERT_EMAILS via the critical path).
//
// Where this runs (PR #283): the EXISTING daily `materialize-recurring-
// breaks` Vercel cron, NOT the admin page render (a render-time write is an
// anti-pattern and would only fire when an operator is already looking) and
// NOT the appointment-reminders route (a dead scheduler never calls it, so
// it cannot self-report). The daily cron runs automatically, independent of
// the external scheduler, so a stale/missing scheduler is detected within
// ~24h without a new job/route/migration. The always-on admin card remains
// the real-time read-only view.
//
// Dedupe: skip if an UNRESOLVED ops_alerts row already exists for the same
// event. An unresolved alert means the operator has not yet handled this
// outage; do not pile on a duplicate each daily run. No auto-resolve — the
// operator resolves manually (admin ops-alerts page) after fixing the
// scheduler, matching every other ops alert.
//
// Non-sensitive ONLY: safe_details carry status + timing scalars. NEVER the
// CRON_SECRET, an Authorization header, client phone/email/PII, reminder
// contents, or a provider payload.

const REMINDER_SCHEDULER_DEGRADED_EVENT = "reminder_scheduler_degraded";
const REMINDER_SCHEDULER_STALE_EVENT = "reminder_scheduler_stale";
const REMINDER_SCHEDULER_MISSING_EVENT = "reminder_scheduler_missing";
const HEALTH_ALERT_ROUTE =
  "lib/cron/reminder-heartbeat:recordReminderSchedulerHealthAlert";

export type ReminderSchedulerHealthAlertResult = {
  status: ReminderSchedulerHealth;
  // true when this call recorded a NEW ops alert.
  alerted: boolean;
  // true when an unhealthy status was suppressed by an existing unresolved
  // alert for the same event (dedupe hit).
  deduped: boolean;
};

// Decision plan: whether to record + which event/severity. Returned by the
// pure decider so the side-effecting wrapper just executes it.
export type ReminderSchedulerAlertEvent =
  | typeof REMINDER_SCHEDULER_DEGRADED_EVENT
  | typeof REMINDER_SCHEDULER_STALE_EVENT
  | typeof REMINDER_SCHEDULER_MISSING_EVENT;

export type ReminderSchedulerAlertPlan =
  | { shouldAlert: false; reason: "healthy" | "deduped" }
  | {
      shouldAlert: true;
      event: ReminderSchedulerAlertEvent;
      severity: "warning" | "critical";
    };

// The event each unhealthy status records. Exported so the caller and the
// tests share one mapping instead of restating it.
export function reminderSchedulerAlertEventFor(
  status: ReminderSchedulerHealth,
): ReminderSchedulerAlertEvent | null {
  switch (status) {
    case "healthy":
      return null;
    case "degraded":
      return REMINDER_SCHEDULER_DEGRADED_EVENT;
    case "stale":
      return REMINDER_SCHEDULER_STALE_EVENT;
    case "missing":
      return REMINDER_SCHEDULER_MISSING_EVENT;
  }
}

// Pure, deterministic decision — the testable core. Given the computed
// status and whether an UNRESOLVED ops alert already exists for the matching
// event, decide whether to record a new one.
//   healthy              -> no alert
//   degraded + no dupe   -> warning  reminder_scheduler_degraded
//   stale + no dupe      -> CRITICAL reminder_scheduler_stale
//   missing + no dupe    -> CRITICAL reminder_scheduler_missing
//   any unhealthy + dupe -> no alert (deduped)
//
// PR OPS-01: `stale` is CRITICAL, not warning. recordOpsAlert only emails
// OPS_ALERT_EMAILS for critical severity, so the previous warning meant a dead
// scheduler produced no operator email until the 24h heartbeat TTL expired the
// key into `missing` — up to ~48h of silence. Escalating `stale` makes the
// FIRST daily health check after 45 minutes of scheduler silence email the
// operator. `degraded` stays a warning on purpose: it is the early cadence
// signal (row + admin card), and paging on it would train operators to ignore
// the channel.
export function decideReminderSchedulerAlert(
  status: ReminderSchedulerStatus,
  hasUnresolvedAlertForEvent: boolean,
): ReminderSchedulerAlertPlan {
  const event = reminderSchedulerAlertEventFor(status.status);
  if (event === null) {
    return { shouldAlert: false, reason: "healthy" };
  }
  if (hasUnresolvedAlertForEvent) {
    return { shouldAlert: false, reason: "deduped" };
  }
  return {
    shouldAlert: true,
    event,
    severity: status.status === "degraded" ? "warning" : "critical",
  };
}

// Pure builder for the alert's safe_details. NON-SENSITIVE scalars only —
// status + timing. Intentionally carries NO CRON_SECRET, Authorization
// header, client phone/email/PII, reminder contents, or provider payload.
export function reminderSchedulerAlertSafeDetails(
  status: ReminderSchedulerStatus,
  nowMs: number,
): Record<string, unknown> {
  return {
    status: status.status,
    last_success_at: status.lastSuccessAt,
    age_minutes: status.ageMinutes,
    cadence_minutes: status.cadenceMinutes,
    degraded_after_minutes: status.degradedAfterMinutes,
    stale_after_minutes: status.staleAfterMinutes,
    checked_at: new Date(nowMs).toISOString(),
  };
}

function reminderSchedulerAlertMessage(
  status: "degraded" | "stale" | "missing",
): string {
  const remedy =
    "Check the external scheduler (cron-job.org), the CRON_SECRET configuration, and recent Vercel logs; resolve this alert after the scheduler is confirmed healthy.";
  if (status === "missing") {
    return `The external appointment-reminder scheduler has no recorded successful run (missing heartbeat). Appointment reminders may be silently stopped. ${remedy}`;
  }
  if (status === "degraded") {
    return `The external appointment-reminder scheduler is running slower than its required cadence (last success older than twice the expected interval). The 2h reminder window is only as wide as twice the cadence, so at this rate some appointments can stop receiving a 2h reminder. ${remedy}`;
  }
  return `The external appointment-reminder scheduler heartbeat is stale (no successful run within the stale threshold). Appointment reminders may be delayed or stopped. ${remedy}`;
}

// Best-effort, fail-open. Reads the heartbeat, classifies, and records ONE
// deduped ops alert when the scheduler is degraded/stale/missing. Never throws
// — a health-check failure must never break the daily cron that calls it.
// `nowMs` is injected so tests are time-independent.
//
// SAFE TO CALL FROM SEVERAL DAILY CRONS. The dedupe below keys on an
// UNRESOLVED ops_alerts row for the same event, so the 08:00, 09:00 and 09:30
// UTC checks record at most ONE alert per outage per event — the second and
// third callers of the day dedupe. This is what makes the monitor survive any
// single daily cron route failing.
export async function recordReminderSchedulerHealthAlert(
  nowMs: number = Date.now(),
): Promise<ReminderSchedulerHealthAlertResult> {
  // readReminderHeartbeat is itself fail-open (returns null on any error)
  // and computeReminderSchedulerStatus is pure, so status is always safely
  // computed; null/unconfigured reads as "missing".
  const status = computeReminderSchedulerStatus(
    await readReminderHeartbeat(),
    nowMs,
  );
  if (status.status === "healthy") {
    return { status: "healthy", alerted: false, deduped: false };
  }
  // Narrowed to the unhealthy states, so the event mapping is total.
  const unhealthy: "degraded" | "stale" | "missing" = status.status;
  const event = reminderSchedulerAlertEventFor(unhealthy) as ReminderSchedulerAlertEvent;

  // Dedupe on an existing UNRESOLVED alert for this exact event. On a read
  // error, fall through (hasUnresolved=false) and record — recordOpsAlert is
  // fail-open; a rare duplicate beats silently dropping a scheduler-down alert.
  let hasUnresolved = false;
  try {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("ops_alerts")
      .select("id")
      .eq("event", event)
      .is("resolved_at", null)
      .limit(1);
    hasUnresolved = Boolean(existing && existing.length > 0);
  } catch {
    hasUnresolved = false;
  }

  const plan = decideReminderSchedulerAlert(status, hasUnresolved);
  if (!plan.shouldAlert) {
    return {
      status: status.status,
      alerted: false,
      deduped: plan.reason === "deduped",
    };
  }

  await recordOpsAlert({
    severity: plan.severity,
    event: plan.event,
    message: reminderSchedulerAlertMessage(unhealthy),
    route: HEALTH_ALERT_ROUTE,
    safeDetails: reminderSchedulerAlertSafeDetails(status, nowMs),
  });
  return { status: status.status, alerted: true, deduped: false };
}

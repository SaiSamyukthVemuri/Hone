import "server-only";
import { dbErrorCode } from "@/lib/logging/error-class";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { declineOwnerEmailActivation } from "@/lib/waitlist/decline-owner-email-gate";

// 0326: is the scheduled erase of overdue waitlist decline answers actually running? The 10:00 route cannot report its own absence, so the three
// earlier daily crons (08:00, 09:00, 09:30) each call checkRetentionHealthAndAlert. It reads waitlist_retention_health() (service_role only) and
// raises critical ops alerts through recordOpsAlert. EVERY alert carries counts, ages in hours and an error class: no studio, client, answer or id.

export const RETENTION_MISSED_AFTER_SECONDS = 93_600; // 26 h, the contract's rule
/** An unerased answer this long past its deadline is an unmet erasure obligation (Insurance #8). */
export const RETENTION_OVERDUE_AFTER_SECONDS = 86_400; // 24 h
/** Three checks run within 90 minutes; the failed alert may also come from the 10:00 route 22 h earlier. One alert per event per ~day. */
export const RETENTION_ALERT_DEDUPE_HOURS = 23;

export const RETENTION_EVENTS = {
  missed: "waitlist_answers_erase_missed",
  failed: "waitlist_answers_erase_failed",
  overdue: "waitlist_answers_erase_overdue",
  stuckEmail: "waitlist_owner_email_stuck",
} as const;
export type RetentionAlertKind = keyof typeof RETENTION_EVENTS;
/** A quiet info row (no email) written the FIRST time overdue answers are seen, so the next check can tell "two consecutive checks" without any other state. */
export const RETENTION_OVERDUE_SEEN_EVENT = "waitlist_answers_overdue_seen";
export const RETENTION_OVERDUE_SEEN_WINDOW_HOURS = 26;

// Shape of waitlist_retention_health() in contract v2 (0326). Counts, timestamps and an outcome word only.
export type RetentionHealth = {
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastErasedCount: number;
  lastFailedCount: number;
  overdueUnerasedCount: number;
  oldestOverdueAgeHours: number | null;
  stuckHeldOutboxCount: number;
};

export type RetentionFinding = { kind: RetentionAlertKind; severity: "critical" | "warning"; message: string; details: Record<string, unknown> };
export type RetentionEvaluation = { findings: RetentionFinding[]; markOverdueSeen: boolean };

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Parse the one row of waitlist_retention_health(); anything malformed is null (unknown), never "healthy". numeric arrives as a number or a string. */
export function parseRetentionHealth(data: unknown): RetentionHealth | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const counts = [num(r.last_erased_count), num(r.last_failed_count), num(r.overdue_unerased_count), num(r.stuck_held_outbox_count)];
  if (counts.some((c) => c === null)) return null;
  return {
    lastSuccessAt: str(r.last_success_at),
    lastRunAt: str(r.last_run_at),
    lastOutcome: str(r.last_outcome),
    lastErasedCount: counts[0] as number,
    lastFailedCount: counts[1] as number,
    overdueUnerasedCount: counts[2] as number,
    oldestOverdueAgeHours: num(r.oldest_overdue_age_hours),
    stuckHeldOutboxCount: counts[3] as number,
  };
}

/**
 * The contract's alert rules (v2), plus the 24 h overdue rule. Pure. The age is computed from the timestamp, not trusted from the database.
 *  missed     = no success ever, or the last success is older than 26 h
 *  failed     = the last run's outcome is failed or partial_failure
 *  overdue    = unerased answers past their deadline on two consecutive checks, or the oldest is already more than 24 h overdue
 *  stuckEmail = owner emails held or sending for more than 24 h, but only once owner email is activated
 */
export function evaluateRetentionHealth(
  h: RetentionHealth,
  nowMs: number,
  ctx: { emailActivated: boolean; overdueSeenRecently: boolean },
): RetentionEvaluation {
  const findings: RetentionFinding[] = [];
  const success = ms(h.lastSuccessAt);
  const ageSeconds = success === null ? null : Math.max(0, Math.round((nowMs - success) / 1000));
  const ageHours = ageSeconds === null ? null : round1(ageSeconds / 3600);

  if (success === null || (ageSeconds !== null && ageSeconds > RETENTION_MISSED_AFTER_SECONDS)) {
    findings.push({
      kind: "missed",
      severity: "critical",
      message:
        ageHours === null
          ? "The scheduled erase of overdue waitlist answers has no successful run on record."
          : `The scheduled erase of overdue waitlist answers has not succeeded for ${ageHours} hours.`,
      details: { hours_since_success: ageHours, threshold_hours: round1(RETENTION_MISSED_AFTER_SECONDS / 3600) },
    });
  }
  if (h.lastOutcome === "failed" || h.lastOutcome === "partial_failure") {
    findings.push({
      kind: "failed",
      severity: "critical",
      message:
        h.lastOutcome === "partial_failure"
          ? `The latest run of the scheduled erase of overdue waitlist answers skipped ${h.lastFailedCount} answers that failed to erase.`
          : "The latest run of the scheduled erase of overdue waitlist answers failed.",
      details: { last_outcome: h.lastOutcome, failed_answers: h.lastFailedCount, erased_answers: h.lastErasedCount, hours_since_success: ageHours },
    });
  }
  let markOverdueSeen = false;
  if (h.overdueUnerasedCount > 0) {
    const oldest = h.oldestOverdueAgeHours;
    if ((oldest !== null && oldest > RETENTION_OVERDUE_AFTER_SECONDS / 3600) || ctx.overdueSeenRecently) {
      findings.push({
        kind: "overdue",
        severity: "critical",
        message: `${h.overdueUnerasedCount} waitlist answers are past their erase deadline and not yet erased${oldest === null ? "" : `; the oldest is ${round1(oldest)} hours overdue`}.`,
        details: { overdue_unerased_answers: h.overdueUnerasedCount, oldest_overdue_hours: oldest === null ? null : round1(oldest), consecutive_checks: ctx.overdueSeenRecently },
      });
    } else {
      markOverdueSeen = true;
    }
  }
  if (ctx.emailActivated && h.stuckHeldOutboxCount > 0) {
    findings.push({
      kind: "stuckEmail",
      severity: "warning",
      message: `${h.stuckHeldOutboxCount} waitlist owner emails have been held or sending for more than 24 hours.`,
      details: { stuck_owner_emails: h.stuckHeldOutboxCount },
    });
  }
  return { findings, markOverdueSeen };
}

export type RetentionCheckResult =
  | { status: "unavailable" }
  | { status: "checked"; findings: RetentionAlertKind[]; alerted: RetentionAlertKind[]; deduped: RetentionAlertKind[] };

/** True when an unresolved alert for this event was already raised inside the dedupe window. Unreadable means "not seen", so a rare duplicate beats a silent miss. */
async function alreadyAlerted(event: string, nowMs: number): Promise<boolean> {
  try {
    const since = new Date(nowMs - RETENTION_ALERT_DEDUPE_HOURS * 3_600_000).toISOString();
    const { data, error } = await createAdminClient().from("ops_alerts").select("id").eq("event", event).is("resolved_at", null).gte("created_at", since).limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Raise one deduped critical alert. Shared by the health check and the 10:00 route's own failed-run alert. Never throws. */
export async function raiseRetentionAlert(
  kind: RetentionAlertKind,
  message: string,
  details: Record<string, unknown>,
  route: string,
  nowMs: number = Date.now(),
  severity: "critical" | "warning" = "critical",
): Promise<"alerted" | "deduped"> {
  const event = RETENTION_EVENTS[kind];
  if (await alreadyAlerted(event, nowMs)) return "deduped";
  await recordOpsAlert({ severity, event, message, route, safeDetails: details });
  return "alerted";
}

/** Was an overdue answer already seen by a check inside the last 26 h? (An unreadable table reads as "not seen".) */
async function overdueSeenRecently(nowMs: number): Promise<boolean> {
  try {
    const since = new Date(nowMs - RETENTION_OVERDUE_SEEN_WINDOW_HOURS * 3_600_000).toISOString();
    const { data, error } = await createAdminClient().from("ops_alerts").select("id").eq("event", RETENTION_OVERDUE_SEEN_EVENT).gte("created_at", since).limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Read the heartbeat and raise whatever is wrong. Read-only except for ops alerts. Never throws. */
export async function checkRetentionHealthAndAlert(route: string, nowMs: number = Date.now()): Promise<RetentionCheckResult> {
  let health: RetentionHealth | null = null;
  try {
    const { data, error } = await createAdminClient().rpc("waitlist_retention_health");
    if (error) {
      // Not installed yet (before 0326) or unreadable: the check cannot say anything, and says so in the log by class only.
      console.warn(JSON.stringify({ event: "waitlist_retention_health_unreadable", code: dbErrorCode(error), route, timestamp: new Date().toISOString() }));
      return { status: "unavailable" };
    }
    health = parseRetentionHealth(data);
  } catch {
    return { status: "unavailable" };
  }
  if (!health) return { status: "unavailable" };
  const { findings, markOverdueSeen } = evaluateRetentionHealth(health, nowMs, {
    emailActivated: declineOwnerEmailActivation().enabled,
    overdueSeenRecently: health.overdueUnerasedCount > 0 ? await overdueSeenRecently(nowMs) : false,
  });
  if (markOverdueSeen) {
    await recordOpsAlert({ severity: "info", event: RETENTION_OVERDUE_SEEN_EVENT, message: "Waitlist answers past their erase deadline were seen by a health check.", route, safeDetails: { overdue_unerased_answers: health.overdueUnerasedCount } });
  }
  const alerted: RetentionAlertKind[] = [];
  const deduped: RetentionAlertKind[] = [];
  for (const f of findings) {
    ((await raiseRetentionAlert(f.kind, f.message, f.details, route, nowMs, f.severity)) === "alerted" ? alerted : deduped).push(f.kind);
  }
  return { status: "checked", findings: findings.map((f) => f.kind), alerted, deduped };
}

import "server-only";
import { dbErrorCode } from "@/lib/logging/error-class";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { waitlistDeclineAnswersEnabled } from "@/lib/waitlist/decline-answers-gate";
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
  unavailable: "waitlist_retention_unavailable",
} as const;
export type RetentionAlertKind = keyof typeof RETENTION_EVENTS;
/** An owner email still held or sending this long after it was created is stuck. */
export const RETENTION_STUCK_EMAIL_AFTER_HOURS = 24;

// Shape of waitlist_retention_health() in contract v2 (0326). Counts, timestamps and an outcome word only.
export type RetentionHealth = {
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastErasedCount: number;
  lastFailedCount: number;
  overdueUnerasedCount: number;
  oldestOverdueAgeHours: number | null;
};

export type RetentionFinding = { kind: RetentionAlertKind; severity: "critical" | "warning"; message: string; details: Record<string, unknown> };
export type RetentionEvaluation = { findings: RetentionFinding[] };

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
  const counts = [num(r.last_erased_count), num(r.last_failed_count), num(r.overdue_unerased_count)];
  if (counts.some((c) => c === null)) return null;
  return {
    lastSuccessAt: str(r.last_success_at),
    lastRunAt: str(r.last_run_at),
    lastOutcome: str(r.last_outcome),
    lastErasedCount: counts[0] as number,
    lastFailedCount: counts[1] as number,
    overdueUnerasedCount: counts[2] as number,
    oldestOverdueAgeHours: num(r.oldest_overdue_age_hours),
  };
}

/**
 * The contract's alert rules (v2), plus the 24 h overdue rule. Pure. The age is computed from the timestamp, not trusted from the database.
 *  missed     = no success ever, or the last success is older than 26 h
 *  failed     = the last run's outcome is failed or partial_failure
 *  overdue    = the oldest unerased answer is more than 24 h past its deadline. (The 08:00, 09:00 and 09:30 checks run BEFORE the 10:00 job, so an
 *               answer that came due since yesterday's run is normally overdue by a few hours at check time: only 24 h means a missed or failing run.)
 *  stuckEmail = owner emails held or sending for more than 24 h and created since activation, counted by the caller, only once owner email is activated
 */
export function evaluateRetentionHealth(
  h: RetentionHealth,
  nowMs: number,
  ctx: { stuckOwnerEmails: number | null },
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
          ? `The latest run of the scheduled erase of overdue waitlist answers finished with failures (${h.lastFailedCount} answers not erased; any other failure was a clean-up step).`
          : "The latest run of the scheduled erase of overdue waitlist answers failed.",
      details: { last_outcome: h.lastOutcome, failed_answers: h.lastFailedCount, erased_answers: h.lastErasedCount, hours_since_success: ageHours },
    });
  }
  const oldest = h.oldestOverdueAgeHours;
  if (h.overdueUnerasedCount > 0 && oldest !== null && oldest > RETENTION_OVERDUE_AFTER_SECONDS / 3600) {
    findings.push({
      kind: "overdue",
      severity: "critical",
      message: `${h.overdueUnerasedCount} waitlist answers are past their erase deadline and not yet erased; the oldest is ${round1(oldest)} hours overdue.`,
      details: { overdue_unerased_answers: h.overdueUnerasedCount, oldest_overdue_hours: round1(oldest) },
    });
  }
  if (ctx.stuckOwnerEmails !== null && ctx.stuckOwnerEmails > 0) {
    findings.push({
      kind: "stuckEmail",
      severity: "warning",
      message: `${ctx.stuckOwnerEmails} waitlist owner emails have been held or sending for more than ${RETENTION_STUCK_EMAIL_AFTER_HOURS} hours.`,
      details: { stuck_owner_emails: ctx.stuckOwnerEmails },
    });
  }
  return { findings };
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

/** Owner emails held or sending for more than 24 h that were created since activation (earlier rows are never claimed, so they are not stuck, they are dark). Counts only; null when unreadable. */
async function countStuckOwnerEmails(since: Date, nowMs: number): Promise<number | null> {
  try {
    const older = new Date(nowMs - RETENTION_STUCK_EMAIL_AFTER_HOURS * 3_600_000).toISOString();
    const { count, error } = await createAdminClient()
      .from("waitlist_decline_owner_emails")
      .select("id", { count: "exact", head: true })
      .in("status", ["held", "sending"])
      .lt("created_at", older)
      .gte("created_at", since.toISOString());
    if (error) {
      console.warn(JSON.stringify({ event: "waitlist_stuck_owner_email_count_unreadable", code: dbErrorCode(error), timestamp: new Date().toISOString() }));
      return null;
    }
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

/**
 * The retention functions are missing or unreadable. Before anything depends on them (the answers flag off, owner email not activated) that is a quiet
 * log line. Once answers are being collected or owner email is activated, a job that cannot run is a missed erasure duty: raise a critical alert.
 * Returns whether it alerted. Shared by the 10:00 route and the health check. Never throws.
 */
export async function alertRetentionUnavailable(reason: "not_installed" | "unavailable", route: string, nowMs: number = Date.now()): Promise<"alerted" | "deduped" | "quiet"> {
  let active = false;
  try {
    active = waitlistDeclineAnswersEnabled() || declineOwnerEmailActivation().enabled;
  } catch {
    active = false;
  }
  if (!active) {
    console.warn(JSON.stringify({ event: "waitlist_retention_not_active_yet", reason, route, timestamp: new Date().toISOString() }));
    return "quiet";
  }
  return raiseRetentionAlert(
    "unavailable",
    "The scheduled erase of waitlist answers cannot run: its database functions are missing or unreadable while answers are being collected or owner email is active.",
    { reason },
    route,
    nowMs,
  );
}

/** Read the heartbeat and raise whatever is wrong. Read-only except for ops alerts. Never throws. */
export async function checkRetentionHealthAndAlert(route: string, nowMs: number = Date.now()): Promise<RetentionCheckResult> {
  let health: RetentionHealth | null = null;
  try {
    const { data, error } = await createAdminClient().rpc("waitlist_retention_health");
    if (error) {
      // Not installed yet (before 0326) or unreadable: the check cannot say anything, and says so in the log by class only.
      console.warn(JSON.stringify({ event: "waitlist_retention_health_unreadable", code: dbErrorCode(error), route, timestamp: new Date().toISOString() }));
      await alertRetentionUnavailable("unavailable", route, nowMs);
      return { status: "unavailable" };
    }
    health = parseRetentionHealth(data);
  } catch {
    await alertRetentionUnavailable("unavailable", route, nowMs);
    return { status: "unavailable" };
  }
  if (!health) {
    await alertRetentionUnavailable("unavailable", route, nowMs);
    return { status: "unavailable" };
  }
  // The outbox read is the app's, not the health function's: the function cannot tell a pre-activation row (never sent, by design) from a stuck one.
  const activation = declineOwnerEmailActivation();
  const { findings } = evaluateRetentionHealth(health, nowMs, {
    stuckOwnerEmails: activation.enabled ? await countStuckOwnerEmails(activation.since, nowMs) : null,
  });
  const alerted: RetentionAlertKind[] = [];
  const deduped: RetentionAlertKind[] = [];
  for (const f of findings) {
    ((await raiseRetentionAlert(f.kind, f.message, f.details, route, nowMs, f.severity)) === "alerted" ? alerted : deduped).push(f.kind);
  }
  return { status: "checked", findings: findings.map((f) => f.kind), alerted, deduped };
}

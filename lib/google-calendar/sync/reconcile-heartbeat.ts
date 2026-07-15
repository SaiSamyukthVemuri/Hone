import "server-only";
import { Redis } from "@upstash/redis";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import type { ReconcileRunResult } from "./reconcile";

// Google Calendar — Phase B2.3-b: operator-visible heartbeat for the reconciliation
// sweep. Mirrors lib/cron/reminder-heartbeat.ts: a single overwritten Upstash key
// (NOT the append-only ops_alerts table), FAIL-OPEN, non-sensitive scalars only.
//
// Posture: FAIL-OPEN. The write is best-effort and never throws — a heartbeat
// failure must never break a reconcile run (and the run itself never touches a
// booking). The read returns null on any error. Locally (no Upstash) it reads as
// missing/unknown. NOTE: this is distinct from the reconcile LOCK, which is
// FAIL-CLOSED — observability failing open must never be confused with the lock,
// whose failure stops the sweep.
//
// NON-SENSITIVE ONLY: timestamps + aggregate run counts + a safe error class.
// NEVER a client name/email/phone, appointment content, Google event id, calendar
// id, OAuth token, or the CRON_SECRET.
//
// STALE-RUN ALERTING IS BUILT BUT NOT ACTIVATED IN B2.3-b. The reconcile route has
// no cron schedule yet (that is B2.3-c), so there is no expected cadence to be
// "stale" against and a missing heartbeat is EXPECTED during dormancy. The pure
// classifier + deduped alert recorder below are provided (and unit-tested) so
// B2.3-c can wire them to a daily health check once the sweep runs on a schedule;
// nothing in this phase invokes recordReconcileSchedulerHealthAlert automatically.

const HEARTBEAT_KEY = "gcal_reconcile:last_run";
const HEARTBEAT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7d — long enough that a dead sweep reads "stale", not vanished

// Only meaningful once a cron cadence exists (B2.3-c). Conservative default.
export const RECONCILE_STALE_AFTER_MINUTES = 60 * 25; // ~25h (a daily cadence + slack)

export type ReconcileHeartbeat = {
  at: string; // ISO timestamp of the last completed run
  outcome: "ok" | "error";
  durationMs?: number;
  eligibleStudios?: number;
  studiosSwept?: number;
  studiosSkippedHeld?: number;
  studiosSkippedUnavailable?: number;
  candidates?: number;
  enqueued?: number;
  skipped?: number;
  superseded?: number;
  errors?: number;
  truncatedStudios?: number; // studios whose paging hit the bound before draining
  byClass?: Record<string, number>;
  errorClass?: string; // a coarse, non-sensitive error label when outcome='error'
};

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

// Build a PHI-free heartbeat from a run result. Pure + exported for tests.
export function reconcileHeartbeatFromRun(
  run: ReconcileRunResult,
  opts: { at: string; durationMs?: number; outcome?: "ok" | "error"; errorClass?: string },
): ReconcileHeartbeat {
  return {
    at: opts.at,
    outcome: opts.outcome ?? "ok",
    durationMs: opts.durationMs,
    eligibleStudios: run.eligibleStudios,
    studiosSwept: run.studiosSwept,
    studiosSkippedHeld: run.studiosSkippedHeld,
    studiosSkippedUnavailable: run.studiosSkippedUnavailable,
    candidates: run.candidates,
    enqueued: run.enqueued,
    skipped: run.skipped,
    superseded: run.superseded,
    errors: run.errors,
    truncatedStudios: run.results.filter((r) => r.truncated).length,
    byClass: { ...run.byClass },
    ...(opts.errorClass ? { errorClass: opts.errorClass } : {}),
  };
}

// Best-effort, fail-open. Called by the reconcile route after a run.
export async function recordReconcileRun(heartbeat: ReconcileHeartbeat): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(HEARTBEAT_KEY, heartbeat, { ex: HEARTBEAT_TTL_SECONDS });
  } catch {
    // A heartbeat write must never break the reconcile run.
  }
}

export async function readReconcileHeartbeat(): Promise<ReconcileHeartbeat | null> {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get<ReconcileHeartbeat | string>(HEARTBEAT_KEY);
    if (!raw) return null;
    const hb = typeof raw === "string" ? (JSON.parse(raw) as ReconcileHeartbeat) : raw;
    return hb && typeof hb.at === "string" ? hb : null;
  } catch {
    return null;
  }
}

export type ReconcileSchedulerStatus = {
  status: "healthy" | "stale" | "missing";
  lastRunAt: string | null;
  ageMinutes: number | null;
  staleAfterMinutes: number;
};

// Pure classifier (testable core). `nowMs` injected for determinism.
export function computeReconcileStatus(
  heartbeat: ReconcileHeartbeat | null,
  nowMs: number,
): ReconcileSchedulerStatus {
  const base = { staleAfterMinutes: RECONCILE_STALE_AFTER_MINUTES };
  const parsed = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  if (Number.isNaN(parsed)) {
    return { status: "missing", lastRunAt: null, ageMinutes: null, ...base };
  }
  const ageMinutes = Math.max(0, Math.round((nowMs - parsed) / 60000));
  return {
    status: ageMinutes <= RECONCILE_STALE_AFTER_MINUTES ? "healthy" : "stale",
    lastRunAt: heartbeat!.at,
    ageMinutes,
    ...base,
  };
}

const RECONCILE_STALE_EVENT = "calendar_reconcile_stale";
const RECONCILE_MISSING_EVENT = "calendar_reconcile_missing";

export type ReconcileAlertPlan =
  | { shouldAlert: false; reason: "healthy" | "deduped" }
  | { shouldAlert: true; event: string; severity: "warning" | "critical" };

// Pure decider (testable). healthy -> none; missing+no dupe -> critical;
// stale+no dupe -> warning; existing unresolved alert -> deduped.
export function decideReconcileAlert(
  status: ReconcileSchedulerStatus,
  hasUnresolvedAlertForEvent: boolean,
): ReconcileAlertPlan {
  if (status.status === "healthy") return { shouldAlert: false, reason: "healthy" };
  if (hasUnresolvedAlertForEvent) return { shouldAlert: false, reason: "deduped" };
  if (status.status === "missing") {
    return { shouldAlert: true, event: RECONCILE_MISSING_EVENT, severity: "critical" };
  }
  return { shouldAlert: true, event: RECONCILE_STALE_EVENT, severity: "warning" };
}

// PHI-free safe_details for a stale/missing alert.
export function reconcileAlertSafeDetails(
  status: ReconcileSchedulerStatus,
  nowMs: number,
): Record<string, unknown> {
  return {
    status: status.status,
    last_run_at: status.lastRunAt,
    age_minutes: status.ageMinutes,
    stale_after_minutes: status.staleAfterMinutes,
    checked_at: new Date(nowMs).toISOString(),
  };
}

export type ReconcileHealthAlertResult = {
  status: "healthy" | "stale" | "missing";
  alerted: boolean;
  deduped: boolean;
};

// Deduped ops alert for a stale/missing reconcile scheduler. Fail-open; never
// throws. NOT invoked by any cron in B2.3-b (see the module header) — wired in
// B2.3-c once the sweep runs on a schedule. `nowMs` injected for tests.
export async function recordReconcileSchedulerHealthAlert(
  nowMs: number = Date.now(),
): Promise<ReconcileHealthAlertResult> {
  const status = computeReconcileStatus(await readReconcileHeartbeat(), nowMs);
  if (status.status === "healthy") return { status: "healthy", alerted: false, deduped: false };

  const event = status.status === "missing" ? RECONCILE_MISSING_EVENT : RECONCILE_STALE_EVENT;
  let hasUnresolved = false;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("ops_alerts").select("id").eq("event", event).is("resolved_at", null).limit(1);
    hasUnresolved = Boolean(data && data.length > 0);
  } catch {
    hasUnresolved = false;
  }

  const plan = decideReconcileAlert(status, hasUnresolved);
  if (!plan.shouldAlert) {
    return { status: status.status, alerted: false, deduped: plan.reason === "deduped" };
  }

  await recordOpsAlert({
    severity: plan.severity,
    event: plan.event,
    message:
      status.status === "missing"
        ? "The Google Calendar reconciliation sweep has no recorded run (missing heartbeat)."
        : "The Google Calendar reconciliation sweep heartbeat is stale (no recent run).",
    route: "lib/google-calendar/sync/reconcile-heartbeat:recordReconcileSchedulerHealthAlert",
    safeDetails: reconcileAlertSafeDetails(status, nowMs),
  });
  return { status: status.status, alerted: true, deduped: false };
}

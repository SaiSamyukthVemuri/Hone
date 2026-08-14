import "server-only";
import { Redis } from "@upstash/redis";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import type { ReconcileCoordinator, ReconcileRunResult, RunOutcome } from "./reconcile";

// Google Calendar: Phase B2.3-b: operator-visible heartbeat + health/dead-row
// alerting for the reconciliation sweep. Mirrors lib/cron/reminder-heartbeat.ts: a
// single overwritten Upstash key (NOT the append-only ops_alerts table), FAIL-OPEN,
// non-sensitive scalars only.
//
// FAIL-OPEN posture: the heartbeat/alert writes are best-effort and never throw: a
// failure must never break a reconcile run (and the run itself never touches a
// booking). This is DISTINCT from the reconcile LOCK + CONTINUATION, which are
// FAIL-CLOSED correctness state: observability failing open must not be confused
// with those.
//
// NON-SENSITIVE ONLY: timestamps + aggregate run counts + a coarse outcome/error
// class + (for a studio alert) a studio_id + count. NEVER a client name/email/phone,
// appointment content, Google event id, calendar id, OAuth token, or the CRON_SECRET.
//
// STALE-RUN + DEAD-ROW ALERTING ARE BUILT BUT NOT SCHEDULED IN B2.3-b. The reconcile
// route has no cron cadence yet (that is B2.3-c), so an always-on stale alert would
// fire spuriously during dormancy. The pure classifiers + recorders below are
// provided (and unit-tested) so B2.3-c can wire them to a schedule; the route DOES
// call the dead-row sweep on each (authorized) invocation, which is safe because it
// only fires when real dead rows exist (production has none).

const HEARTBEAT_KEY = "gcal_reconcile:last_run";
const HEARTBEAT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7d

// Only meaningful once a cron cadence exists (B2.3-c). Conservative default.
export const RECONCILE_STALE_AFTER_MINUTES = 60 * 25; // ~25h

export type ReconcileOutcome = RunOutcome; // "ok" | "degraded" | "error"

export type ReconcileHeartbeat = {
  at: string; // ISO completion time of the last run
  startedAt?: string; // ISO start time (retained separately)
  outcome: ReconcileOutcome;
  durationMs?: number;
  eligibleStudios?: number;
  studiosAttempted?: number;
  studiosCompleted?: number;
  studiosTruncated?: number;
  studiosDeferred?: number; // eligible studios not attempted this invocation
  studiosSkippedHeld?: number;
  studiosSkippedUnavailable?: number;
  studiosContinuationFailed?: number;
  coordinatorSkipped?: "held" | "unavailable" | null;
  cursorReadFailed?: boolean;
  cursorPersistFailed?: boolean;
  intentVerifyFailed?: number;
  deadRowDeferred?: boolean;
  candidates?: number;
  enqueued?: number;
  skipped?: number;
  superseded?: number;
  errors?: number;
  byClass?: Record<string, number>;
  errorClass?: string;
};

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

// Build a PHI-free heartbeat from a run result. `at` = completion time. Pure. The
// `outcome` passed in may already be downgraded (e.g. dead-row work deferred).
export function reconcileHeartbeatFromRun(
  run: ReconcileRunResult,
  opts: { at: string; startedAt?: string; durationMs?: number; errorClass?: string; outcome?: ReconcileOutcome; deadRowDeferred?: boolean },
): ReconcileHeartbeat {
  return {
    at: opts.at,
    startedAt: opts.startedAt,
    outcome: opts.outcome ?? run.outcome,
    durationMs: opts.durationMs,
    eligibleStudios: run.eligibleStudios,
    studiosAttempted: run.studiosAttempted,
    studiosCompleted: run.studiosCompleted,
    studiosTruncated: run.studiosTruncated,
    studiosDeferred: run.studiosDeferred,
    studiosSkippedHeld: run.studiosSkippedHeld,
    studiosSkippedUnavailable: run.studiosSkippedUnavailable,
    studiosContinuationFailed: run.studiosContinuationFailed,
    coordinatorSkipped: run.coordinatorSkipped,
    cursorReadFailed: run.cursorReadFailed,
    cursorPersistFailed: run.cursorPersistFailed,
    intentVerifyFailed: run.intentVerifyFailed,
    deadRowDeferred: opts.deadRowDeferred,
    candidates: run.candidates,
    enqueued: run.enqueued,
    skipped: run.skipped,
    superseded: run.superseded,
    errors: run.errors,
    byClass: { ...run.byClass },
    ...(opts.errorClass ? { errorClass: opts.errorClass } : {}),
  };
}

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

// A recent run is NOT healthy merely because it is recent: its OUTCOME matters.
export type ReconcileSchedulerStatus = {
  status: "healthy" | "degraded" | "error" | "stale" | "missing";
  lastRunAt: string | null;
  outcome: ReconcileOutcome | null;
  ageMinutes: number | null;
  staleAfterMinutes: number;
};

export function computeReconcileStatus(heartbeat: ReconcileHeartbeat | null, nowMs: number): ReconcileSchedulerStatus {
  const base = { staleAfterMinutes: RECONCILE_STALE_AFTER_MINUTES };
  const parsed = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  if (Number.isNaN(parsed)) {
    return { status: "missing", lastRunAt: null, outcome: null, ageMinutes: null, ...base };
  }
  const ageMinutes = Math.max(0, Math.round((nowMs - parsed) / 60000));
  const outcome = heartbeat!.outcome ?? "ok";
  if (ageMinutes > RECONCILE_STALE_AFTER_MINUTES) {
    return { status: "stale", lastRunAt: heartbeat!.at, outcome, ageMinutes, ...base };
  }
  // Recent: reflect the run outcome.
  const status = outcome === "error" ? "error" : outcome === "degraded" ? "degraded" : "healthy";
  return { status, lastRunAt: heartbeat!.at, outcome, ageMinutes, ...base };
}

const STATUS_EVENT: Record<Exclude<ReconcileSchedulerStatus["status"], "healthy">, { event: string; severity: "warning" | "critical" }> = {
  error: { event: "calendar_reconcile_error", severity: "critical" },
  degraded: { event: "calendar_reconcile_degraded", severity: "warning" },
  stale: { event: "calendar_reconcile_stale", severity: "warning" },
  missing: { event: "calendar_reconcile_missing", severity: "critical" },
};

export type ReconcileAlertPlan =
  | { shouldAlert: false; reason: "healthy" | "deduped" }
  | { shouldAlert: true; event: string; severity: "warning" | "critical" };

// healthy -> none; error/missing -> critical; degraded/stale -> warning; an existing
// unresolved alert for the SAME event -> deduped.
export function decideReconcileAlert(status: ReconcileSchedulerStatus, hasUnresolvedAlertForEvent: boolean): ReconcileAlertPlan {
  if (status.status === "healthy") return { shouldAlert: false, reason: "healthy" };
  if (hasUnresolvedAlertForEvent) return { shouldAlert: false, reason: "deduped" };
  const map = STATUS_EVENT[status.status];
  return { shouldAlert: true, event: map.event, severity: map.severity };
}

export function reconcileAlertSafeDetails(status: ReconcileSchedulerStatus, nowMs: number): Record<string, unknown> {
  return {
    status: status.status,
    outcome: status.outcome,
    last_run_at: status.lastRunAt,
    age_minutes: status.ageMinutes,
    stale_after_minutes: status.staleAfterMinutes,
    checked_at: new Date(nowMs).toISOString(),
  };
}

// Deduped scheduler-health alert. Fail-open; NOT invoked by any cron in B2.3-b.
export async function recordReconcileSchedulerHealthAlert(nowMs: number = Date.now()): Promise<{
  status: ReconcileSchedulerStatus["status"];
  alerted: boolean;
  deduped: boolean;
}> {
  const status = computeReconcileStatus(await readReconcileHeartbeat(), nowMs);
  if (status.status === "healthy") return { status: "healthy", alerted: false, deduped: false };
  const event = STATUS_EVENT[status.status].event;
  let hasUnresolved = false;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("ops_alerts").select("id").eq("event", event).is("resolved_at", null).limit(1);
    hasUnresolved = Boolean(data && data.length > 0);
  } catch {
    hasUnresolved = false;
  }
  const plan = decideReconcileAlert(status, hasUnresolved);
  if (!plan.shouldAlert) return { status: status.status, alerted: false, deduped: plan.reason === "deduped" };
  await recordOpsAlert({
    severity: plan.severity,
    event: plan.event,
    message: `The Google Calendar reconciliation sweep is ${status.status} (outcome=${status.outcome ?? "unknown"}).`,
    route: "lib/google-calendar/sync/reconcile-heartbeat:recordReconcileSchedulerHealthAlert",
    safeDetails: reconcileAlertSafeDetails(status, nowMs),
  });
  return { status: status.status, alerted: true, deduped: false };
}

// ---------------------------------------------------------------------------
// §8, dead-row operational signal. The phase register assigns dead-row alerting
// to B2.3-b. A PHI-free, deduped, per-studio ops alert for terminal dead outbox
// work. It NEVER touches an outbox row (a dead row is never reopened under its
// idempotency key). A resolved alert recurs when NEW dead rows appear.
// ---------------------------------------------------------------------------
export const DEAD_ROW_EVENT = "calendar_outbox_dead_rows";

// Pure decider: alert only when there are dead rows AND no unresolved alert exists.
export function decideDeadRowAlert(deadCount: number, hasUnresolvedAlert: boolean): { shouldAlert: boolean } {
  if (deadCount <= 0) return { shouldAlert: false }; // none -> no alert; existing resolved alerts stay resolved
  if (hasUnresolvedAlert) return { shouldAlert: false }; // dedupe
  return { shouldAlert: true };
}

export function deadRowAlertSafeDetails(studioId: string, deadCount: number, nowMs: number): Record<string, unknown> {
  return { studio_id: studioId, dead_count: deadCount, checked_at: new Date(nowMs).toISOString() };
}

// Record a deduped PHI-free dead-row alert for ONE studio. Fail-open (never throws).
export async function recordCalendarDeadRowAlert(
  studioId: string,
  deadCount: number,
  nowMs: number = Date.now(),
): Promise<{ alerted: boolean; deduped: boolean }> {
  try {
    if (deadCount <= 0) return { alerted: false, deduped: false };
    let hasUnresolved = false;
    try {
      const admin = createAdminClient();
      const { data } = await admin
        .from("ops_alerts")
        .select("id")
        .eq("event", DEAD_ROW_EVENT)
        .eq("studio_id", studioId)
        .is("resolved_at", null)
        .limit(1);
      hasUnresolved = Boolean(data && data.length > 0);
    } catch {
      hasUnresolved = false;
    }
    const plan = decideDeadRowAlert(deadCount, hasUnresolved);
    if (!plan.shouldAlert) return { alerted: false, deduped: hasUnresolved };
    await recordOpsAlert({
      severity: "warning",
      event: DEAD_ROW_EVENT,
      message: "Google Calendar outbound sync has terminal dead-lettered operations awaiting operator review.",
      studioId,
      route: "lib/google-calendar/sync/reconcile-heartbeat:recordCalendarDeadRowAlert",
      safeDetails: deadRowAlertSafeDetails(studioId, deadCount, nowMs),
    });
    return { alerted: true, deduped: false };
  } catch {
    return { alerted: false, deduped: false }; // fail-open
  }
}

// The dead-row alert campaign's explicit outcome model (§10).
export type DeadRowSweepOutcome = "completed" | "deferred" | "skipped_held" | "unavailable" | "error";
export type DeadRowSweepResult = {
  outcome: DeadRowSweepOutcome;
  coordinatorStatus: "ok" | "held" | "unavailable";
  studios: number; // examined this invocation
  alerted: number; // new alerts created
  deduped: number; // suppressed by an existing unresolved alert
  deferred: boolean;
  cursor: string | null; // last fully-processed studio id (safe operational field)
  errorClass?: string;
  cursorPersistFailed?: boolean;
};

// Run the dead-row alert campaign under its OWN dead-alert coordinator (a separate
// lock + durable cursor namespace from the main reconciliation coordinator: the two
// are never held simultaneously by one invocation). It reads the pre-aggregated
// `calendar_sync_queue_health` view via **durable cursor** pagination (immutable
// studio_id) (no raw 10k-row scan) resuming AFTER the persisted cursor, bounded by
// the per-invocation studio cap + the route deadline, ownership-atomically persisting
// the cursor after each fully-processed studio and clearing it on completion.
//
// FAIL-CLOSED coordination: a held coordinator -> `skipped_held` (no unlocked sweep);
// an unavailable backend, or a cursor read I/O error -> `unavailable` (never run from
// an unknown position). A store/inventory failure -> `error` (NOT a completed sweep).
// The alert INSERT + best-effort signalling remain fail-open (business ops never
// blocked), but a failure is reported truthfully: fail-open ≠ "maintenance succeeded".
export async function sweepCalendarDeadRowAlerts(
  store: { pageStudiosWithDeadOutbox(afterStudioId: string | null, limit: number): Promise<{ studioId: string; deadCount: number }[]> },
  coordinator: ReconcileCoordinator,
  opts: { now?: () => number; deadlineMs?: number; pageSize?: number; maxStudios?: number } = {},
): Promise<DeadRowSweepResult> {
  const now = opts.now ?? Date.now;
  const deadlineMs = opts.deadlineMs ?? Number.POSITIVE_INFINITY;
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 100));
  const maxStudios = Math.max(1, Math.floor(opts.maxStudios ?? 500));
  const empty = { studios: 0, alerted: 0, deduped: 0, deferred: false, cursor: null as string | null };

  const acq = await coordinator.acquire();
  if (!acq.ok) {
    // held = a concurrent campaign owns it (benign); unavailable = backend down.
    return { ...empty, outcome: acq.reason === "held" ? "skipped_held" : "unavailable", coordinatorStatus: acq.reason };
  }
  const token = acq.token;
  try {
    const cur = await coordinator.readCursor();
    if (!cur.ok) {
      // Read I/O error: do NOT run from an unknown position (distinct from absent).
      return { ...empty, outcome: "unavailable", coordinatorStatus: "unavailable" };
    }
    let after = cur.cursor; // absent (null) => start at the beginning
    let studios = 0;
    let alerted = 0;
    let deduped = 0;
    let deferred = false;
    let lastProcessed: string | null = cur.cursor;
    let cursorPersistFailed = false;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (now() >= deadlineMs || studios >= maxStudios) {
          deferred = true;
          break;
        }
        if (!(await coordinator.renew(token))) {
          deferred = true; // lost the lease -> stop; last persisted cursor stands
          break;
        }
        const page = await store.pageStudiosWithDeadOutbox(after, pageSize);
        if (page.length === 0) break; // fully drained
        let broke = false;
        for (const r of page) {
          if (now() >= deadlineMs || studios >= maxStudios) {
            deferred = true;
            broke = true;
            break;
          }
          // The alert decision finishes BEFORE the cursor advances.
          const res = await recordCalendarDeadRowAlert(r.studioId, r.deadCount, now());
          if (res.alerted) alerted++;
          if (res.deduped) deduped++;
          studios++;
          // Ownership-atomically persist ONLY after the studio is fully processed.
          if (!(await coordinator.writeCursor(token, r.studioId))) {
            cursorPersistFailed = true;
            broke = true;
            break;
          }
          after = r.studioId;
          lastProcessed = r.studioId;
        }
        if (broke) break;
        if (page.length < pageSize) break; // drained
      }
    } catch (err) {
      // Inventory/processing failure -> truthful error (NOT a completed sweep).
      return {
        outcome: "error",
        coordinatorStatus: "ok",
        studios,
        alerted,
        deduped,
        deferred: true,
        cursor: lastProcessed,
        errorClass: err instanceof Error ? err.name : "unknown",
      };
    }

    if (cursorPersistFailed) {
      return { outcome: "error", coordinatorStatus: "ok", studios, alerted, deduped, deferred: true, cursor: lastProcessed, cursorPersistFailed: true };
    }
    if (deferred) {
      return { outcome: "deferred", coordinatorStatus: "ok", studios, alerted, deduped, deferred: true, cursor: lastProcessed };
    }
    // Reached the end -> ownership-atomically clear the durable cursor.
    const cleared = await coordinator.writeCursor(token, null);
    return cleared
      ? { outcome: "completed", coordinatorStatus: "ok", studios, alerted, deduped, deferred: false, cursor: null }
      : { outcome: "error", coordinatorStatus: "ok", studios, alerted, deduped, deferred: true, cursor: lastProcessed, cursorPersistFailed: true };
  } finally {
    await coordinator.release(token);
  }
}

// §11, the final reconciliation-heartbeat tier given the main run + the dead-row
// sweep. `error` is reserved for a reconciliation-run failure. A successful run whose
// dead-row campaign was anything other than `completed` (deferred / skipped_held /
// unavailable / error) is at least `degraded`, never falsely `ok`.
export function finalHeartbeatOutcome(runOutcome: RunOutcome, deadOutcome: DeadRowSweepOutcome): RunOutcome {
  if (runOutcome === "error") return "error";
  if (deadOutcome !== "completed") return "degraded";
  return runOutcome;
}

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// DELIVERY-VISIBILITY-01 — email delivery health and the recovery heartbeat
// (migration 0215).
//
// email_delivery_health() reads one row: the receipt backlog, receipts that
// were exhausted, quarantined or could not be attributed, accepted attempts the
// provider never reported on, open incidents and the last sweep. This module
// turns it into FINDINGS, each with a purpose-specific threshold. A finding is
// raised as an ops alert at most once while an unresolved alert for the same
// event is open (the PR #283 dedupe rule), so a long outage is one alert, not
// one per run.
//
// UNKNOWN IS NOT SUCCESS. A health read that fails, or a sweep that has never
// run, is itself a finding: it is never reported as healthy.

export type EmailDeliveryHealth = {
  pendingReceipts: number;
  oldestPendingSeconds: number | null;
  exhausted24h: number;
  quarantined24h: number;
  unmatched24h: number;
  unreportedAccepted: number;
  openIncidents: number;
  lastSweepAt: string | null;
  lastSweepFailed: number | null;
};

export type HealthFinding = {
  event:
    | "email_delivery_backlog_stale"
    | "email_delivery_receipts_exhausted"
    | "email_delivery_receipts_quarantined"
    | "email_delivery_unreported"
    | "email_delivery_sweep_failing";
  severity: "warning" | "critical";
  message: string;
  details: Record<string, number | string | null>;
};

/** Thresholds, each named for the failure it catches. */
export const HEALTH_THRESHOLDS = {
  /** A receipt the sweep should have finished within a few runs. */
  stalePendingSeconds: 15 * 60,
  /** A pending receipt this old means processing has stopped altogether. */
  criticalPendingSeconds: 6 * 60 * 60,
} as const;

function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** The pure decision: which findings this health row warrants. */
export function healthFindings(
  h: EmailDeliveryHealth,
  limits: typeof HEALTH_THRESHOLDS = HEALTH_THRESHOLDS,
): HealthFinding[] {
  const out: HealthFinding[] = [];
  if (h.oldestPendingSeconds !== null && h.oldestPendingSeconds > limits.stalePendingSeconds) {
    out.push({
      event: "email_delivery_backlog_stale",
      severity: h.oldestPendingSeconds > limits.criticalPendingSeconds ? "critical" : "warning",
      message: `Email delivery events are waiting to be processed: ${h.pendingReceipts} pending, the oldest for ${Math.round(
        h.oldestPendingSeconds / 60,
      )} minutes.`,
      details: { pending_receipts: h.pendingReceipts, oldest_pending_seconds: h.oldestPendingSeconds },
    });
  }
  if (h.exhausted24h > 0) {
    out.push({
      event: "email_delivery_receipts_exhausted",
      severity: "warning",
      message: `${h.exhausted24h} email delivery event(s) failed processing five times in 24 hours and were quarantined.`,
      details: { exhausted_24h: h.exhausted24h },
    });
  }
  if (h.quarantined24h > h.exhausted24h) {
    out.push({
      event: "email_delivery_receipts_quarantined",
      severity: "warning",
      message: `${h.quarantined24h - h.exhausted24h} email delivery event(s) in 24 hours could not be applied (unknown type, mismatched or contradictory ids).`,
      details: { quarantined_24h: h.quarantined24h, exhausted_24h: h.exhausted24h },
    });
  }
  if (h.unreportedAccepted > 0) {
    out.push({
      event: "email_delivery_unreported",
      severity: "warning",
      message: `${h.unreportedAccepted} accepted email(s) have had no delivery report for 24 hours. Their outcome is unknown, not delivered.`,
      details: { unreported_accepted: h.unreportedAccepted },
    });
  }
  if (h.lastSweepFailed !== null && h.lastSweepFailed > 0) {
    out.push({
      event: "email_delivery_sweep_failing",
      severity: "warning",
      message: `The last email delivery recovery sweep failed to process ${h.lastSweepFailed} event(s).`,
      details: { last_sweep_failed: h.lastSweepFailed, last_sweep_at: h.lastSweepAt },
    });
  }
  return out;
}

function logHealth(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

export async function readEmailDeliveryHealth(
  admin: SupabaseClient,
): Promise<EmailDeliveryHealth | null> {
  try {
    const { data, error } = await admin.rpc("email_delivery_health");
    if (error) {
      logHealth("email_delivery_health_failed", { shape: "rpc_error" });
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row) {
      logHealth("email_delivery_health_failed", { shape: "empty" });
      return null;
    }
    return {
      pendingReceipts: int(row.pending_receipts),
      oldestPendingSeconds: row.oldest_pending_seconds == null ? null : int(row.oldest_pending_seconds),
      exhausted24h: int(row.exhausted_24h),
      quarantined24h: int(row.quarantined_24h),
      unmatched24h: int(row.unmatched_24h),
      unreportedAccepted: int(row.unreported_accepted),
      openIncidents: int(row.open_incidents),
      lastSweepAt: typeof row.last_sweep_at === "string" ? row.last_sweep_at : null,
      lastSweepFailed: row.last_sweep_failed == null ? null : int(row.last_sweep_failed),
    };
  } catch {
    logHealth("email_delivery_health_failed", { shape: "threw" });
    return null;
  }
}

/** Record one sweep run. Returns false when the heartbeat could not be written. */
export async function recordEmailSweepRun(
  admin: SupabaseClient,
  run: { claimed: number; processed: number; failed: number },
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("record_email_sweep_run", {
      p_claimed: run.claimed,
      p_processed: run.processed,
      p_failed: run.failed,
    });
    if (error || data !== "recorded") {
      logHealth("email_sweep_heartbeat_failed", { shape: error ? "rpc_error" : "unexpected" });
      return false;
    }
    return true;
  } catch {
    logHealth("email_sweep_heartbeat_failed", { shape: "threw" });
    return false;
  }
}

/**
 * True when an UNRESOLVED ops alert for this event already exists, so another
 * would only repeat it. A read failure answers false: an extra alert is
 * preferable to a silent one.
 */
export async function hasOpenOpsAlert(admin: SupabaseClient, event: string): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("ops_alerts")
      .select("id")
      .eq("event", event)
      .is("resolved_at", null)
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

import "server-only";
import { recordOpsAlertDurably } from "@/lib/ops/alerts";

// NON-MUTATING sweep for a manual fee attempt that is stuck (a monitoring requirement: detection that does not depend on
// the charge runner or the webhook running again).
//
// WHAT IT FINDS. A payment_charge_attempts row whose charge_reason is no_show_fee or late_cancellation_fee, whose status is
// pending_stripe (claimed: a sender may or may not have reached Stripe), and whose CLAIM time is older than
// STUCK_FEE_AFTER_MINUTES. The claim time is claimed_at (0352: stamped once at ready -> pending_stripe, immutable), falling back
// to updated_at only for an attempt claimed before 0352 (claimed_at NULL).
//
// WHICH STATES. A sent attempt can only be pending_stripe: the status CHECK (0073:121-128) has no requires_action; that is a
// Stripe status the runner cancels and records as failed (session-payment-charge.ts requires_action finalizer), so filtering
// on it would never match. tests/lib/billing/stuck-fee-sweep.test.ts pins both facts. Two kinds, told apart because the action differs:
//   fee_stuck_no_pi            no PaymentIntent id was recorded: the sender may have died before or after Stripe saw the request.
//   fee_stuck_pi_unreconciled  a PaymentIntent id exists but the attempt never reached a terminal state (webhook and refresh
//                              both missed it).
// "ready" is NOT stuck (a prepared fee waits for the owner's press), and succeeded, failed, cancelled and blocked are terminal.
//
// N = 30 MINUTES. A live sender finishes in seconds: the PaymentIntent is created with maxNetworkRetries 0 and the function
// is capped at 60 s on this plan, so a healthy attempt is never older than about two minutes. 30 minutes is more than
// ten times that (no false alarm for a slow Stripe or a cold start) and short enough that a person can act the same day.
// Detection latency is bounded by the cron cadence, not by N: this plan runs crons once a day, so the first alert comes at
// the next run after N has passed. A sub-daily cadence is a plan decision, not made here.
//
// WHAT IT DOES. Reads attempts; writes ONLY an ops_alerts row (the existing critical alert
// "session_payment_needs_manual_review", which also emails OPS_ALERT_EMAILS) through recordOpsAlertDurably. It NEVER updates or
// deletes an attempt, never calls Stripe, never charges, refunds, cancels or retries. First responder: the on-call operator. Stripe
// investigation escalates to the platform operator.
//
// ONCE PER ATTEMPT (DEDUPE). Before alerting, it looks for an existing alert with the same event, the same attempt id in
// safe_details and the same sweep reason; if one exists (resolved or not) it stays silent. A run that fails to persist the
// alert is retried by the next run, because nothing was recorded. Two runs racing at the same instant could double-alert
// once; the cron is not invoked concurrently, and a duplicate alert is harmless.

export const STUCK_FEE_AFTER_MINUTES = 30;
export const STUCK_FEE_EVENT = "session_payment_needs_manual_review";
export const STUCK_FEE_SWEEP_READ_FAILED_EVENT = "stuck_fee_sweep_read_failed";
export const STUCK_FEE_REASON_NO_PI = "fee_stuck_no_pi";
export const STUCK_FEE_REASON_PI_UNRECONCILED = "fee_stuck_pi_unreconciled";
export const STUCK_FEE_BATCH_LIMIT = 200;
// A page is STUCK_FEE_BATCH_LIMIT rows; the sweep walks pages until one is short, up to this many. Rows that have already alerted stay
// pending_stripe (the sweep never changes an attempt), so without paging the first 200 would be the same already-alerted rows every day
// and a newer stuck attempt behind them would never be looked at. Hitting the cap sets `truncated` (and the route reports it).
export const STUCK_FEE_MAX_PAGES = 10;

type AttemptRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  appointment_id: string | null;
  charge_reason: string;
  stripe_payment_intent_id: string | null;
  updated_at: string;
  claimed_at: string | null;
};

// The narrow surface used. The real admin client satisfies it; a test fake records every call.
type Admin = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export type StuckFeeSweepSummary = {
  scanned: number;
  stuck: number;
  alerted: number;
  already_alerted: number;
  alert_failed: number;
  read_failed: boolean;
  /** True when STUCK_FEE_MAX_PAGES full pages were read and more rows may remain: some stuck attempt may not have been looked at. */
  truncated: boolean;
};

export async function sweepStuckFeeAttempts(args: { admin: Admin; now?: Date }): Promise<StuckFeeSweepSummary> {
  const now = args.now ?? new Date();
  const cutoff = new Date(now.getTime() - STUCK_FEE_AFTER_MINUTES * 60_000).toISOString();
  const summary: StuckFeeSweepSummary = { scanned: 0, stuck: 0, alerted: 0, already_alerted: 0, alert_failed: 0, read_failed: false, truncated: false };

  const rows: AttemptRow[] = [];
  let data: unknown = null;
  let error: unknown = null;
  for (let page = 0; page < STUCK_FEE_MAX_PAGES; page++) {
    const from = page * STUCK_FEE_BATCH_LIMIT;
    const res = await args.admin
      .from("payment_charge_attempts")
      .select("id, studio_id, client_id, appointment_id, charge_reason, stripe_payment_intent_id, updated_at, claimed_at")
      .in("charge_reason", ["no_show_fee", "late_cancellation_fee"])
      .eq("status", "pending_stripe")
      // age = coalesce(claimed_at, updated_at) < cutoff
      .or(`claimed_at.lt.${cutoff},and(claimed_at.is.null,updated_at.lt.${cutoff})`)
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + STUCK_FEE_BATCH_LIMIT - 1);
    data = res.data;
    error = res.error;
    if (error || !Array.isArray(data)) break;
    rows.push(...(data as AttemptRow[]));
    if (data.length < STUCK_FEE_BATCH_LIMIT) break;
    if (page === STUCK_FEE_MAX_PAGES - 1) summary.truncated = true;
  }
  if (error || !Array.isArray(data)) {
    // The sweep's own read failed: detection has stopped, which is itself an incident. Raise a critical alert (never silent)
    // and report read_failed so the route answers non-200.
    summary.read_failed = true;
    await recordOpsAlertDurably({
      severity: "critical",
      event: STUCK_FEE_SWEEP_READ_FAILED_EVENT,
      message: "The stuck manual fee sweep could not read fee attempts, so no stuck fee can be detected right now. Nothing was changed.",
      route: "lib/billing/stuck-fee-sweep:sweepStuckFeeAttempts",
      safeDetails: { reason: "sweep_read_failed" },
    });
    return summary;
  }

  summary.scanned = rows.length;
  for (const row of rows) {
    const reason = row.stripe_payment_intent_id ? STUCK_FEE_REASON_PI_UNRECONCILED : STUCK_FEE_REASON_NO_PI;
    summary.stuck++;

    const { data: existing, error: existingErr } = await args.admin
      .from("ops_alerts")
      .select("id")
      .eq("event", STUCK_FEE_EVENT)
      .eq("safe_details->>attempt_id", row.id)
      .eq("safe_details->>reason", reason)
      .limit(1);
    // An unreadable dedupe check must not spam: skip this attempt, the next run looks again.
    if (existingErr || !Array.isArray(existing)) {
      summary.alert_failed++;
      continue;
    }
    if (existing.length > 0) {
      summary.already_alerted++;
      continue;
    }

    const persisted = await recordOpsAlertDurably({
      severity: "critical",
      event: STUCK_FEE_EVENT,
      message:
        reason === STUCK_FEE_REASON_NO_PI
          ? `A manual fee has been pending for more than ${STUCK_FEE_AFTER_MINUTES} minutes with no PaymentIntent id. Nothing was changed. Check Stripe before anyone retries.`
          : `A manual fee has been pending for more than ${STUCK_FEE_AFTER_MINUTES} minutes with a PaymentIntent that never reached a final state. Nothing was changed. Check Stripe.`,
      studioId: row.studio_id,
      clientId: row.client_id,
      appointmentId: row.appointment_id,
      stripePaymentIntentId: row.stripe_payment_intent_id,
      route: "lib/billing/stuck-fee-sweep:sweepStuckFeeAttempts",
      safeDetails: {
        attempt_id: row.id,
        charge_reason: row.charge_reason,
        reason,
        pending_since: row.claimed_at ?? row.updated_at,
        pending_since_source: row.claimed_at ? "claimed_at" : "updated_at",
        threshold_minutes: STUCK_FEE_AFTER_MINUTES,
      },
    });
    if (persisted) summary.alerted++;
    else summary.alert_failed++;
  }
  return summary;
}

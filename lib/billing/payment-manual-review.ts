// PR #290. Pure, dependency-free selection + safe view-models for the
// READ-ONLY admin payment manual-review queue
// (app/admin/payments/manual-review/page.tsx).
//
// This module has NO server-only import, NO database, NO Stripe — so it is
// trivially unit-testable and cannot mutate anything. The page does the
// service-role reads (mirroring docs/16 §17.7's read-only reconciliation
// SELECTs) and renders these view-models. The view-model mappers copy ONLY a
// fixed allowlist of safe fields, so a row carrying client names / notes /
// raw messages / card data can never leak into the rendered queue.

// The synchronous reconcile window is 60 min (RECONCILIATION_WINDOW_MINUTES in
// session-payment-charge.ts; docs/16 §17.7 query (1)). A pending_stripe row
// older than this may be an unreconciled charge — surface it for review.
export const STUCK_PENDING_THRESHOLD_MINUTES = 60;

// Conservative operator guidance shown on the queue. Deliberately tells the
// operator NOT to retry/refund blindly and to follow the readiness runbook.
export const MANUAL_REVIEW_NEXT_STEP =
  "Review this PaymentIntent in the Stripe dashboard and compare it with the Hone attempt. Do NOT retry the charge or issue a refund blindly — follow the live-payment readiness runbook (docs/16 §17) before any action. Resolve the related alert on the Ops alerts page once reconciled.";

// Critical payment-alert event prefixes that belong in the manual-review
// queue. Combined with severity='critical' + resolved_at IS NULL at the query
// layer, this is exactly the operator-actionable payment-risk set: Stripe
// succeeded but Hone could not persist (session_payment_succeeded_write_*),
// retrieve/unknown errors + stale pending (session_payment_needs_manual_review),
// refund write failures / unknown outcomes (payment_refund_*), webhook
// terminal-state / livemode / metadata mismatches (payment_intent_*,
// charge_refunded_*, stripe_webhook_metadata_mismatch / _processing_failed),
// and disputes (payment_charge_dispute_*). WARNING-level reconciliation alerts
// (no_match, *_reconcile_zero_rows, livemode_event_ignored) and card-on-file
// setup failures are deliberately EXCLUDED — they stay on /admin/ops-alerts.
export const PAYMENT_MANUAL_REVIEW_EVENT_PREFIXES = [
  "session_payment_",
  "payment_intent_",
  "payment_refund_",
  "payment_charge_",
  "charge_refunded_",
  "stripe_webhook_",
] as const;

export function isPaymentManualReviewEvent(
  event: string | null | undefined,
): boolean {
  if (!event) return false;
  return PAYMENT_MANUAL_REVIEW_EVENT_PREFIXES.some((p) => event.startsWith(p));
}

// Non-sensitive amount label, e.g. "$50.00 CAD". null when not present.
export function formatAmountLabel(
  amountCents: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (amountCents == null || !Number.isFinite(amountCents)) return null;
  const code = (currency ?? "").trim().toUpperCase() || "CAD";
  return `$${(amountCents / 100).toFixed(2)} ${code}`;
}

function embedName(
  embed: { name: string | null } | { name: string | null }[] | null | undefined,
): string | null {
  const row = Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null);
  return row?.name ?? null;
}

// ---------------------------------------------------------------------------
// Section 1: payment attempts stuck in pending_stripe.
// ---------------------------------------------------------------------------
export type StuckAttemptRow = {
  id: string;
  studio_id: string | null;
  studio?: { name: string | null } | { name: string | null }[] | null;
  client_id: string | null;
  session_id: string | null;
  appointment_id: string | null;
  charge_reason: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: string | null;
  stripe_payment_intent_id: string | null;
  stripe_livemode: boolean | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  // Any other columns the query might carry are intentionally ignored.
  [extra: string]: unknown;
};

export type StuckAttemptView = {
  attemptId: string;
  studioId: string | null;
  studioName: string | null;
  clientId: string | null;
  sessionId: string | null;
  appointmentId: string | null;
  chargeReason: string | null;
  amountLabel: string | null;
  status: string | null;
  stripePaymentIntentId: string | null;
  livemode: boolean;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

// Copies ONLY the safe allowlist — never the client name, notes,
// failure_message_safe, card data, or any other column.
export function toStuckAttemptView(row: StuckAttemptRow): StuckAttemptView {
  return {
    attemptId: row.id,
    studioId: row.studio_id ?? null,
    studioName: embedName(row.studio),
    clientId: row.client_id ?? null,
    sessionId: row.session_id ?? null,
    appointmentId: row.appointment_id ?? null,
    chargeReason: row.charge_reason ?? null,
    amountLabel: formatAmountLabel(row.amount_cents, row.currency),
    status: row.status ?? null,
    stripePaymentIntentId: row.stripe_payment_intent_id ?? null,
    livemode: row.stripe_livemode === true,
    failureCode: row.failure_code ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Section 2: unresolved critical payment ops alerts.
// ---------------------------------------------------------------------------
export type ReviewAlertRow = {
  id: string;
  created_at: string;
  severity: string;
  event: string;
  // Redacted at write time by recordOpsAlert (PR #285) — safe to display.
  message: string;
  studio_id: string | null;
  client_id: string | null;
  appointment_id: string | null;
  stripe_payment_intent_id: string | null;
  route: string | null;
  // Present only when the caller selected it; absent === treated as unresolved
  // (the page query already filters resolved_at IS NULL).
  resolved_at?: string | null;
  [extra: string]: unknown;
};

export type ReviewAlertView = {
  alertId: string;
  createdAt: string;
  severity: string;
  event: string;
  message: string;
  studioId: string | null;
  clientId: string | null;
  appointmentId: string | null;
  stripePaymentIntentId: string | null;
  route: string | null;
};

export function toReviewAlertView(row: ReviewAlertRow): ReviewAlertView {
  return {
    alertId: row.id,
    createdAt: row.created_at,
    severity: row.severity,
    event: row.event,
    message: row.message,
    studioId: row.studio_id ?? null,
    clientId: row.client_id ?? null,
    appointmentId: row.appointment_id ?? null,
    stripePaymentIntentId: row.stripe_payment_intent_id ?? null,
    route: row.route ?? null,
  };
}

// Keep ONLY unresolved (resolved_at IS NULL) CRITICAL alerts whose event is a
// payment manual-review event. The page query already filters severity +
// resolved_at for efficiency; this re-applies all three predicates so the full
// selection rule is pure + testable (a warning, a resolved alert, or a
// non-payment critical that ever reached this function is dropped).
export function selectPaymentReviewAlerts(
  rows: ReadonlyArray<ReviewAlertRow>,
): ReviewAlertView[] {
  return rows
    .filter(
      (r) =>
        r.severity === "critical" &&
        r.resolved_at == null &&
        isPaymentManualReviewEvent(r.event),
    )
    .map(toReviewAlertView);
}

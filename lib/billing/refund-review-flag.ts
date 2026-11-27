import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlertDurably } from "@/lib/ops/alerts";

// Refunds Stripe reports on a BILLED card payment that Hone did not make (v1 refund truth). The webhook passes RAW closed values; flag_payment_refund_review
// (0394) decides, under the visit lock, whether each refund is known, and opens a review for an unknown one. Nothing is decided here before that lock.
// WHAT THE OPERATOR SEES. A flagged, known or covered refund emits NOTHING studio-attributed from here (the owner sees the review banner). The two
// fail-closed cases (an incomplete refund list, a refusal the database could not place) write ONE durable operator alert with NO studio, client or visit,
// a fixed route, a fixed message and a closed reason.

export const REFUND_REVIEW_ALERT_ROUTE = "app/api/stripe/webhook";
export const FLAG_NO_ROW_REASONS = ["list_incomplete", "refund_evidence_refused"] as const;
export type RefundReviewFailClosedReason = (typeof FLAG_NO_ROW_REASONS)[number] | "unplaceable_refund";
const ALERT_EVENT: Record<RefundReviewFailClosedReason, string> = {
  list_incomplete: "billed_refund_list_incomplete",
  refund_evidence_refused: "billed_refund_evidence_refused",
  unplaceable_refund: "billed_refund_unplaceable",
};
export class RefundReviewUnrecordedError extends Error {
  constructor() {
    super("stripe_webhook_refund_review_unrecorded");
    this.name = "RefundReviewUnrecordedError";
  }
}

export type BilledRefundFlagOutcome =
  | { kind: "not_billed" }
  | { kind: "billed"; failClosed: RefundReviewFailClosedReason | null };

type FlagArgs = {
  attemptId: string; refundId: string | null; status: string | null; amountCents: number | null; currency: string | null;
  eventId: string; eventCreated: number; reason: "partial_dashboard_refund" | (typeof FLAG_NO_ROW_REASONS)[number]; honeRefundId: string | null;
};

async function callFlag(a: FlagArgs): Promise<string> {
  const { data, error } = await createAdminClient().rpc("flag_payment_refund_review", {
    p_attempt_id: a.attemptId, p_stripe_refund_id: a.refundId, p_stripe_refund_status: a.status, p_amount_cents: a.amountCents, p_currency: a.currency,
    p_event_id: a.eventId, p_event_created: a.eventCreated, p_reason_code: a.reason, p_hone_refund_id: a.honeRefundId,
  });
  const r = (Array.isArray(data) ? data[0] : data) as { result?: string } | null;
  // A database that cannot answer is retryable (the route releases the claim and Stripe redelivers); it is never read as "not billed".
  if (error || !r?.result) throw new RefundReviewUnrecordedError();
  return r.result;
}
const PLACED = new Set(["flagged", "known", "already_flagged", "auto_closed", "covered", "ignored"]);
const refundArgs = (attemptId: string, event: Stripe.Event, r: Stripe.Refund): FlagArgs => ({
  attemptId, refundId: r.id, status: r.status ?? null, amountCents: r.amount, currency: r.currency ?? null, eventId: event.id, eventCreated: event.created,
  reason: "partial_dashboard_refund", honeRefundId: r.metadata?.hone_payment_refund_id ?? null,
});

/** charge.refunded: every refund in the list is passed on its own; an incomplete or unreadable list fails closed (no row, no freeze). */
export async function flagChargeRefunds(attemptId: string, event: Stripe.Event, charge: Stripe.Charge): Promise<BilledRefundFlagOutcome> {
  const list = charge.refunds;
  if (!list || list.object !== "list" || list.has_more !== false || !Array.isArray(list.data)) {
    return noRow(attemptId, event, "list_incomplete");
  }
  let failClosed: RefundReviewFailClosedReason | null = null;
  for (const r of list.data) {
    const result = await callFlag(refundArgs(attemptId, event, r));
    if (result === "not_billed") return { kind: "not_billed" };
    if (!PLACED.has(result)) failClosed = "unplaceable_refund";
  }
  return { kind: "billed", failClosed };
}

/** refund.created / refund.updated that the locked payment command refused. */
export async function flagStandaloneRefund(attemptId: string, event: Stripe.Event, refund: Stripe.Refund): Promise<BilledRefundFlagOutcome> {
  const result = await callFlag(refundArgs(attemptId, event, refund));
  if (result === "not_billed") return { kind: "not_billed" };
  return { kind: "billed", failClosed: PLACED.has(result) ? null : "unplaceable_refund" };
}

/** A refusal or an incomplete list: learn whether the payment is billed. Writes nothing. */
export async function noRow(attemptId: string, event: Stripe.Event, reason: (typeof FLAG_NO_ROW_REASONS)[number]): Promise<BilledRefundFlagOutcome> {
  const result = await callFlag({ attemptId, refundId: null, status: null, amountCents: null, currency: null, eventId: event.id, eventCreated: event.created, reason, honeRefundId: null });
  if (result === "not_billed") return { kind: "not_billed" };
  return { kind: "billed", failClosed: result === "billed" ? reason : "unplaceable_refund" };
}

/** The one operator-only alert of a billed fail-closed case. Throws when it cannot be kept, so the route answers 500 and Stripe redelivers. */
export async function recordBilledRefundOperatorAlert(attemptId: string, event: Stripe.Event, reason: RefundReviewFailClosedReason): Promise<void> {
  const kept = await recordOpsAlertDurably({
    severity: "critical", event: ALERT_EVENT[reason],
    message: "A refund on a split-payment card payment could not be placed in the ledger. No payment row was changed.",
    stripeEventId: event.id, route: REFUND_REVIEW_ALERT_ROUTE,
    safeDetails: { attempt_id: attemptId, reason },
  });
  if (kept !== true) throw new RefundReviewUnrecordedError();
}

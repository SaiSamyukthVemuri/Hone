// HON-49 (migration 0358). Builds the evidence object for record_charge_refund_history from ONE signed charge.refunded event.
//
// N2 (recorded in the 0358 design): EVERY identity field in the object comes from the signed event's own charge, never from the stored
// attempt. The database command compares them with what Hone stored when the charge was made; filling them from the stored attempt
// would make that comparison compare Hone with itself and prove nothing. So this builder takes NO attempt argument, by design: a refund
// event whose charge object cannot supply a field (customer, amount, currency, payment intent, charge) is refused by the command.
//
// Only a COMPLETE refund list is sent (refunds.object === "list", has_more === false, at least one refund). A list that may be truncated says
// nothing about the refunds it does not show, so it is not recorded and the event keeps today's loud, critical alert. refund.created /
// refund.updated / refund.failed events are NOT recorded by this change either: they carry one refund and a charge id but not the customer or
// the charge amount, so the command could only be satisfied by filling those from the stored attempt (N2 forbids it). Recording them needs a
// reviewed command change, a separate decision.

import type Stripe from "stripe";

type IdOrObject = string | { id?: string | null } | null | undefined;
const idOf = (v: IdOrObject): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof v.id === "string" ? v.id : null);

export type RefundHistoryEvidence = Record<string, unknown>;

export function buildChargeRefundHistoryEvidence(
  event: { id: string; created: number },
  charge: Stripe.Charge,
): RefundHistoryEvidence | null {
  const list = charge.refunds;
  if (charge.object !== "charge" || !list || list.object !== "list" || list.has_more !== false || !Array.isArray(list.data)
      || list.data.length === 0 || list.data.length > 100) return null;
  if (typeof event.id !== "string" || !event.id.trim() || !Number.isSafeInteger(event.created) || event.created < 0) return null;
  if (!Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0) return null;
  return {
    customer_id: idOf(charge.customer as IdOrObject),
    payment_intent_id: idOf(charge.payment_intent as IdOrObject),
    charge_id: typeof charge.id === "string" ? charge.id : null,
    amount_cents: charge.amount,
    currency: charge.currency,
    event_created: event.created,
    evidence_kind: "signed_event",
    charge_amount_refunded: charge.amount_refunded,
    charge_refund_list_complete: true,
    components: list.data.map((refund) => ({
      refund_id: refund.id,
      amount_cents: refund.amount,
      currency: refund.currency,
      refund_status: refund.status,
      charge_id: idOf(refund.charge as IdOrObject),
      payment_intent_id: idOf(refund.payment_intent as IdOrObject),
    })),
  };
}

/** Results of the command that mean the refund list is now on record (a replay counts: it is already there). */
export const REFUND_HISTORY_RECORDED = ["recorded", "already_recorded"] as const;
/** Results that mean the command refused the evidence: nothing was written and the event needs an operator. */
export const REFUND_HISTORY_REFUSED = ["identity_mismatch", "refund_evidence_refused", "terminal_refund_mismatch", "invalid_input", "not_found"] as const;

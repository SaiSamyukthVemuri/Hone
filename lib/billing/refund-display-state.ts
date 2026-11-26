// R1 (accurate refund status). ONE pure reading of a charge's refund state, so the owner never sees a status
// the records do not prove. No I/O, no clock, no money movement.
//
// Two columns describe a refund and different code writes them (payment_charge_attempts.refund_status = OUR claim
// lifecycle; stripe_refund_status = the PROVIDER's own state, migration 0240). Showing only ours can say "succeeded"
// while the provider says failed or canceled, or "failed" while the refund is in fact in flight. The agreement rules
// below are the SAME ones lib/billing/outstanding-balance.ts applies to the balance (Insurance V-1, #1356); a
// disagreement or an unrecognised value is "unclear", never resolved by picking one.

export type RefundDisplayInput = {
  /** payment_charge_attempts.status; only a succeeded charge can be refunded. */
  chargeStatus: string | null;
  amountCents: number | null;
  refundStatus: string | null;
  refundAmountCents: number | null;
  providerRefundStatus: string | null;
  /** payment_charge_attempts.stripe_refund_id. The refund runner refuses a NEW attempt once this or the provider status is set. */
  stripeRefundId: string | null;
  /**
   * TRUE only when the row carries the signed complete charge-level cumulative full-refund receipt
   * (payment_charge_attempts.stripe_charge_refund_event_id IS NOT NULL, migration 0240). The id itself is never carried to
   * the display; only whether it exists. That receipt is SEPARATE from the single Refund's id/status and is monotonic: a
   * later single-refund observation cannot undo it, so a single refund recorded failed/canceled beside it is history, not a
   * disagreement.
   */
  cumulativeFullRefundVerified: boolean;
};

export type RefundDisplayKind =
  | "not_refunded" // no refund recorded by either side
  | "refunded" // ours and the provider (or silence) agree it succeeded
  | "pending" // in flight: our claim is held, or the provider says pending
  | "needs_action" // the provider says the refund needs action
  | "failed" // our refund attempt ended without moving money and left NO provider trace; a new attempt is allowed
  | "needs_review" // the provider has recorded an object or an outcome for a refund that did not complete: the studio owner reviews it; no new attempt
  | "unclear"; // the two sides disagree, or a value is unknown: do not guess

export type RefundDisplay = {
  kind: RefundDisplayKind;
  /** Cents still refundable on this charge, or null when it cannot be proven. Never negative. */
  remainingRefundableCents: number | null;
  /** Whether the UI may offer a NEW refund attempt. Only when no refund can be in flight or already done. */
  mayStartRefund: boolean;
};

const KNOWN_OURS = [null, "pending_stripe", "succeeded", "failed"];
const KNOWN_PROVIDER = [null, "pending", "requires_action", "succeeded", "failed", "canceled"];

function remaining(i: RefundDisplayInput, refunded: number): number | null {
  if (typeof i.amountCents !== "number" || i.amountCents < 0) return null;
  if (!Number.isInteger(refunded) || refunded < 0 || refunded > i.amountCents) return null;
  return i.amountCents - refunded;
}

export function refundDisplayState(i: RefundDisplayInput): RefundDisplay {
  const unclear: RefundDisplay = { kind: "unclear", remainingRefundableCents: null, mayStartRefund: false };
  if (i.chargeStatus !== "succeeded") {
    return { kind: "not_refunded", remainingRefundableCents: 0, mayStartRefund: false };
  }
  const ours = i.refundStatus ?? null;
  const provider = i.providerRefundStatus ?? null;
  if (!KNOWN_OURS.includes(ours) || !KNOWN_PROVIDER.includes(provider)) return unclear;

  if (ours === "pending_stripe") {
    // Our claim is held: money may or may not have moved. A provider "failed"/"canceled" while we are still
    // pending is a disagreement until reconciled (D-3: never release on an unknown).
    if (provider === null || provider === "pending") {
      return { kind: "pending", remainingRefundableCents: null, mayStartRefund: false };
    }
    if (provider === "requires_action") {
      return { kind: "needs_action", remainingRefundableCents: null, mayStartRefund: false };
    }
    return unclear;
  }

  if (ours === "succeeded") {
    // Verified cumulative completion comes BEFORE the single refund's status (Codex P2 on #1427). 0240 sets
    // refund_status='succeeded' with the FULL amount from the signed cumulative receipt and leaves stripe_refund_status
    // untouched, so a failed single refund followed by a verified full cumulative refund reads ours=succeeded,
    // provider=failed. That is a completed refund, not a disagreement. Honored only when the receipt is present AND our
    // recorded amount is exactly the whole charge; anything else falls through to the agreement rules below.
    if (
      i.cumulativeFullRefundVerified === true &&
      typeof i.amountCents === "number" &&
      typeof i.refundAmountCents === "number" &&
      remaining(i, i.refundAmountCents) === 0 // exactly the whole charge: valid integers, nothing left
    ) {
      return { kind: "refunded", remainingRefundableCents: 0, mayStartRefund: false };
    }
    if (provider !== null && provider !== "succeeded") {
      if (provider === "pending") return { kind: "pending", remainingRefundableCents: null, mayStartRefund: false };
      if (provider === "requires_action") {
        return { kind: "needs_action", remainingRefundableCents: null, mayStartRefund: false };
      }
      return unclear; // we say succeeded, the provider says failed/canceled
    }
    if (typeof i.refundAmountCents !== "number") return unclear;
    const rem = remaining(i, i.refundAmountCents);
    if (rem === null) return unclear;
    // v1 is full-refund-only: a charge with money left is not offered a second refund here (that is R2).
    return { kind: "refunded", remainingRefundableCents: rem, mayStartRefund: false };
  }

  // ours is null or failed: no refund of ours moved money.
  // payment-refund.ts refuses a NEW attempt once ANY provider trace exists (stripe_refund_id, stripe_refund_status or the
  // event columns that travel with the status): "needs_manual_review". So a new attempt is offered ONLY with no trace.
  const hasProviderTrace = provider !== null || i.stripeRefundId !== null;
  if (provider === null || provider === "failed" || provider === "canceled") {
    const rem = remaining(i, 0);
    if (hasProviderTrace) {
      // The provider recorded a refund that did not complete (or an object id with no status). Money stayed, but the
      // runner will not start another: the operator reviews it. Never "failed" with a retry button that only refuses.
      return { kind: "needs_review", remainingRefundableCents: rem, mayStartRefund: false };
    }
    if (ours === "failed") {
      return { kind: "failed", remainingRefundableCents: rem, mayStartRefund: rem !== null && rem > 0 };
    }
    return { kind: "not_refunded", remainingRefundableCents: rem, mayStartRefund: rem !== null && rem > 0 };
  }
  // The provider reports a refund in flight, done or needing action that we did not record: money we cannot place.
  return unclear;
}

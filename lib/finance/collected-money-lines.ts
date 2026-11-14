// Collected money, as SEPARATE lines, for a future owner totals screen.
// FULL REFUNDS ONLY UNTIL R3: partial refunds are not supported by this module (see below).
//
// Pure. No I/O, no clock, no Stripe. NOT imported by /financials (FIN-01A slice 1 shows no
// money by design; its tests forbid any money read on that path) nor by the dashboard snapshot
// ("Collected revenue: Not enabled yet"). This module is the pinned rule the screen will use,
// so the answer to "does a fee count, and when" is one tested function, not a rewrite.
//
// Sam's ruling (12 Nov 2026), implemented here:
//   * A successfully collected cancellation/no-show fee is INCLUDED, as its OWN line, never
//     folded into session payments.
//   * Pending, failed, cancelled, requires_action, ready and unknown attempts are EXCLUDED from
//     collected revenue.
//   * Refunds reduce the total accurately. Only FULL refunds exist today (partial refunds are
//     R3 and are NOT supported): a fully and provably refunded charge counts 0. A refund that is
//     in flight, needs review or disagrees with the provider cannot be proven, so that charge is
//     reported as `unresolved` with its amount and is NOT counted as collected and NOT subtracted
//     as refunded. A figure is never guessed.
//   * One currency: money in a currency other than the studio's is never summed (U3), it is
//     counted under `otherCurrency`.
import { refundDisplayState } from "@/lib/billing/refund-display-state";

export type CollectedMoneyRow = {
  chargeReason: string | null;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
  refundStatus: string | null;
  refundAmountCents: number | null;
  providerRefundStatus: string | null;
  stripeRefundId: string | null;
  /** Server-derived: the signed cumulative full-refund receipt exists (0240). Required so a caller cannot forget it; the event id is never carried. */
  cumulativeFullRefundVerified: boolean;
  /** payment_charge_attempts.stripe_livemode. Only `true` is real money; a test-mode or unknown mode is never collected. */
  stripeLivemode: boolean | null;
};

export type CollectedLine = {
  /** Cents collected and still kept: succeeded, in the studio currency, and not (fully) refunded. */
  collectedCents: number;
  /** Cents provably refunded in full (informational; already out of collectedCents). */
  refundedCents: number;
  /** Charges that SUCCEEDED but whose refund state cannot be proven: not counted either way. */
  unresolved: { count: number; cents: number };
  /** Succeeded money in a currency other than the studio's: never summed. */
  otherCurrency: { count: number };
  /** Rows deliberately left out because they are not collected money. */
  excluded: number;
};

export type CollectedMoneyLines = {
  sessionPayments: CollectedLine;
  cancellationNoShowFees: CollectedLine;
  /** Said once so a screen cannot imply more: partial refunds are not supported yet. */
  partialRefundsSupported: false;
};

const FEE_REASONS = new Set(["no_show_fee", "late_cancellation_fee"]);

function emptyLine(): CollectedLine {
  return { collectedCents: 0, refundedCents: 0, unresolved: { count: 0, cents: 0 }, otherCurrency: { count: 0 }, excluded: 0 };
}

function add(line: CollectedLine, row: CollectedMoneyRow, studioCurrency: string): void {
  if (row.status !== "succeeded" || row.stripeLivemode !== true) {
    // Not succeeded, or a test-mode (or unknown-mode) success: not collected money (Insurance M1).
    line.excluded += 1;
    return;
  }
  const amount = row.amountCents;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    line.unresolved.count += 1;
    return;
  }
  if (!row.currency || row.currency.toLowerCase() !== studioCurrency.toLowerCase()) {
    line.otherCurrency.count += 1;
    return;
  }
  const refund = refundDisplayState({
    chargeStatus: row.status,
    amountCents: amount,
    refundStatus: row.refundStatus,
    refundAmountCents: row.refundAmountCents,
    providerRefundStatus: row.providerRefundStatus,
    stripeRefundId: row.stripeRefundId,
    cumulativeFullRefundVerified: row.cumulativeFullRefundVerified === true,
  });
  if (refund.kind === "not_refunded" || refund.kind === "failed") {
    // No refund happened (a failed refund with no provider trace left the money in place).
    line.collectedCents += amount;
    return;
  }
  if (refund.kind === "refunded") {
    if (refund.remainingRefundableCents === 0) {
      line.refundedCents += amount; // a full refund: out of collected
    } else {
      // A refunded row that is not a FULL refund is a partial refund: not supported, so unprovable here.
      line.unresolved.count += 1;
      line.unresolved.cents += amount;
    }
    return;
  }
  // pending, needs_action, needs_review, unclear: money may or may not have moved back.
  line.unresolved.count += 1;
  line.unresolved.cents += amount;
}

export function collectedMoneyLines(rows: readonly CollectedMoneyRow[], studioCurrency: string): CollectedMoneyLines {
  const sessionPayments = emptyLine();
  const fees = emptyLine();
  for (const row of rows) {
    if (row.chargeReason === "session_payment") add(sessionPayments, row, studioCurrency);
    else if (row.chargeReason !== null && FEE_REASONS.has(row.chargeReason)) add(fees, row, studioCurrency);
    // Any other reason is not counted anywhere: an unknown reason must never become revenue.
  }
  return { sessionPayments, cancellationNoShowFees: fees, partialRefundsSupported: false };
}

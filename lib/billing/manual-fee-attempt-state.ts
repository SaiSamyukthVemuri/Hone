// What a manual late-cancel / no-show fee attempt can truthfully say about itself.
//
// Pure and framework-free (no server-only imports) so the fee card and its tests share one
// function. The card used to switch on `status` alone: a `pending_stripe` row that never got a
// terminal write (a connection that dropped after Stripe may have processed the request) read as
// "Charge pending" forever, and an unrecognised status fell through to a raw string. Neither
// told the owner the one thing that matters: do NOT charge again until someone has checked.
//
// Rules (the same fail-safe stance as the refund display, R1):
//   * `failed` is shown only when the runner wrote a definitive refusal (it writes `failed`
//     only after Stripe answered "no" or the intent was confirmed cancelled). The
//     `requires_action_canceled` code is the one where the client's card needed their own
//     confirmation: nothing was taken, and the copy says so.
//   * `pending_stripe` is "pending" only while it is recent; past the window, or with no
//     readable time, it is `unclear`. Unclear offers NO action of any kind.
//   * Any status this module does not recognise is `unclear`, never a guess.
//   * `mayRefreshCharge` is true only while pending (the existing refresh re-runs the same
//     idempotent claim; it cannot create a second PaymentIntent). It is false when unclear.

import { refundDisplayState, type RefundDisplay } from "@/lib/billing/refund-display-state";
import { REFUND_ACTION_HEADING, REFUND_REVIEW_HEADING } from "@/lib/payments/payment-summary-presenter";

export type FeeAttemptStateKind =
  | "ready"
  | "pending"
  | "unclear"
  | "succeeded"
  | "failed"
  | "needs_action"
  | "cancelled";

export type FeeAttemptStateInput = {
  status: string | null | undefined;
  failure_code?: string | null;
  /** The provider's PaymentIntent id and our captured-at time: "nothing was taken" needs a provider object and no capture. */
  has_payment_intent?: boolean;
  charged_at?: string | null;
  /** payment_charge_attempts.updated_at: when the row last changed (the claim sets pending_stripe). */
  updated_at?: string | null;
};

export type FeeAttemptState = {
  kind: FeeAttemptStateKind;
  label: string;
  /** True while a new prepare/charge would risk a second charge: in flight or unclear. */
  blocksNewCharge: boolean;
  mayRefreshCharge: boolean;
};

/** A pending charge older than this has had time to finish; if it did not, nobody knows. */
export const FEE_PENDING_WINDOW_MS = 10 * 60 * 1000;

export const FEE_UNCLEAR_MESSAGE =
  "Charge status is unclear. Do not charge again until this is checked.";

export function feeAttemptState(a: FeeAttemptStateInput, now: Date): FeeAttemptState {
  switch (a.status) {
    case "ready":
      return { kind: "ready", label: "Ready to charge", blocksNewCharge: true, mayRefreshCharge: false };
    case "succeeded":
      return { kind: "succeeded", label: "Charged", blocksNewCharge: true, mayRefreshCharge: false };
    case "cancelled":
      return { kind: "cancelled", label: "Cancelled before charging", blocksNewCharge: false, mayRefreshCharge: false };
    case "failed":
      if (a.failure_code === "requires_action_canceled") {
        // "Nothing was taken" is a provider fact: it needs the PaymentIntent the runner cancelled and no
        // capture time. Without both, we cannot say it, so the state is unclear and no charge is offered.
        if (!a.has_payment_intent || a.charged_at) {
          return { kind: "unclear", label: "Charge status unclear", blocksNewCharge: true, mayRefreshCharge: false };
        }
        return {
          kind: "needs_action",
          label: "Needs the client's action; nothing was taken",
          // Blocks a new fee until the owner resolves it (one manual fee per appointment).
          blocksNewCharge: true,
          mayRefreshCharge: false,
        };
      }
      return { kind: "failed", label: "Charge failed", blocksNewCharge: false, mayRefreshCharge: false };
    case "pending_stripe": {
      const t = a.updated_at ? Date.parse(a.updated_at) : Number.NaN;
      const age = now.getTime() - t;
      if (Number.isFinite(t) && age >= 0 && age <= FEE_PENDING_WINDOW_MS) {
        return { kind: "pending", label: "Charge pending", blocksNewCharge: true, mayRefreshCharge: true };
      }
      return { kind: "unclear", label: "Charge status unclear", blocksNewCharge: true, mayRefreshCharge: false };
    }
    default:
      return { kind: "unclear", label: "Charge status unclear", blocksNewCharge: true, mayRefreshCharge: false };
  }
}

/**
 * The refund half of a fee attempt, read through the SHARED refund-status logic (R1,
 * `refundDisplayState`) so the fee card, the session card and the retry rules never disagree.
 * No forked copy: this only maps the shared kind to a label. `line` is null when nothing was
 * refunded and nothing is in flight.
 */
export type FeeRefundInput = {
  status: string | null | undefined;
  amount_cents: number | null | undefined;
  refund_status?: string | null;
  refund_amount_cents?: number | null;
  stripe_refund_status?: string | null;
  stripe_refund_id?: string | null;
};

export function feeRefund(a: FeeRefundInput): { display: RefundDisplay; line: string | null } {
  const display = refundDisplayState({
    chargeStatus: a.status ?? null,
    amountCents: typeof a.amount_cents === "number" ? a.amount_cents : null,
    refundStatus: a.refund_status ?? null,
    refundAmountCents: typeof a.refund_amount_cents === "number" ? a.refund_amount_cents : null,
    providerRefundStatus: a.stripe_refund_status ?? null,
    stripeRefundId: a.stripe_refund_id ?? null,
  });
  switch (display.kind) {
    case "refunded":
      return { display, line: "Refunded" };
    case "pending":
      return { display, line: "Refund processing" };
    case "needs_action":
      return { display, line: REFUND_ACTION_HEADING };
    case "failed":
      // Our own attempt ended and the provider holds no refund object. We do not claim "no money moved":
      // that is a provider fact we do not have here.
      return { display, line: "Refund did not go through" };
    case "needs_review":
    case "unclear":
      return { display, line: REFUND_REVIEW_HEADING };
    case "not_refunded":
      return { display, line: null };
  }
}

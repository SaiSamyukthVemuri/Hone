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
        return {
          kind: "needs_action",
          label: "Needs the client's action; nothing was taken",
          blocksNewCharge: false,
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
 * The refund line for the charge history. Conservative on purpose: our own `refund_status` is
 * trusted only when the provider's record agrees (no provider refund recorded), and anything else
 * says the status is unclear rather than guessing "refunded" or "failed". Whether the full
 * refund-status panel built for session payments (R1) also belongs on the fee card is the
 * owner's ruling; this is the minimum honest line.
 */
export function feeRefundLine(a: {
  status: string | null | undefined;
  refund_status?: string | null;
  stripe_refund_status?: string | null;
  stripe_refund_id?: string | null;
}): string | null {
  if (a.status !== "succeeded") return null;
  const ours = a.refund_status ?? null;
  const provider = a.stripe_refund_status ?? null;
  const hasProviderTrace = provider !== null || (a.stripe_refund_id ?? null) !== null;
  if (ours === null && !hasProviderTrace) return null; // never refunded: say nothing
  if (ours === "succeeded" && provider === "succeeded") return "Refunded";
  if (ours === "pending_stripe" && (provider === null || provider === "pending")) return "Refund processing";
  return "Refund status unclear. Do not refund again until this is checked.";
}

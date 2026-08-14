import type { SessionPaymentAmountResult } from "@/lib/billing/session-payment-amount";

// Review 3780286321. Whether an already-prepared `ready` attempt may still
// expose its money-moving control, given CURRENT authoritative pricing.
//
// `ready` is the only attempt status carrying a Run charge control. It may
// expose that control ONLY while current pricing is `resolved`. The previous
// gate was free-only, so an attempt whose service price had since been cleared
// to NULL, whose custom pricing had become ambiguous, or whose pricing read had
// failed still rendered Run charge. Execution already refuses every one of
// those, so no wrong charge could run — but the practitioner saw an apparently
// runnable control and only discovered the block after submitting.
//
// This lives in a pure module rather than inline in the card for one reason:
// a test that re-implements the card's conditions can only prove the model is
// self-consistent, never that the component obeys it. Both the card and its
// tests import THIS function, so a change to the rule cannot pass unnoticed.
//
// SCOPE — presentation permission only. It decides whether a control is
// offered, never what may be charged. Execution authority stays with
// decideExecutionPricingPermission and the prepared attempt remains the sole
// execution amount.

export type ReadyControlPermission = {
  // The panel may render its money-moving control.
  canRun: boolean;
  // The attempt is `ready` but current pricing withdraws the control, so the
  // surface must explain why instead of silently showing nothing.
  blocked: boolean;
};

export function decideReadyControlPermission(
  attemptStatus: string | null,
  // null means the authoritative pricing context could not be loaded at all.
  amountResult: SessionPaymentAmountResult | null,
): ReadyControlPermission {
  if (attemptStatus !== "ready") {
    // pending_stripe / succeeded are transaction state: money that has already
    // moved. Current pricing never withdraws their panel, receipt or refund
    // controls. Any other status has no panel here at all.
    return { canRun: false, blocked: false };
  }
  const canRun = amountResult?.kind === "resolved";
  return { canRun, blocked: !canRun };
}

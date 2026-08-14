import {
  unresolvedAmountMessage,
  type SessionPaymentAmountResult,
} from "@/lib/billing/session-payment-amount";

// Reviews 3780286321 / 3780371682 / 3780456783.
//
// THE SESSION-PAYMENT CARD'S PRESENTATION DECISION, in one place.
//
// Two separate questions, previously conflated:
//
//   1. Should the persisted attempt be VISIBLE?
//      Always. A prepared attempt is transaction history. Suppressing the
//      panel when current pricing went unresolved made a single prepared
//      payment appear to vanish while it still blocked preparation
//      (AttemptHistory only renders with more than one attempt).
//
//   2. May a READY attempt expose its MONEY-MOVING control?
//      Only while current authoritative pricing is `resolved`. Free, missing
//      price/service, ambiguous custom pricing and a failed pricing read all
//      withdraw it. Execution refuses all of those anyway, so this is UI
//      truth: without it the practitioner saw a runnable-looking control and
//      discovered the block only after clicking.
//
// Current pricing governs whether a READY attempt may still ACT. It never
// erases money that has already MOVED: pending_stripe and succeeded keep their
// panel, receipt and refund controls under every pricing state.
//
// WHY THE WHOLE DECISION LIVES HERE, not just the permission flag.
// The card is a `.tsx` client component and this repository's vitest setup
// renders no components (node environment, `tests/**/*.test.ts`, no jsdom), so
// a test cannot assert on rendered output without new test infrastructure. The
// first version of this module exported only `canRun`, and the tests then
// RECONSTRUCTED the card's render conditions from it — which proves only that
// the reconstruction is self-consistent, not that the component obeys it. So
// the complete render decision is computed here and the card merely reads the
// fields. There is no branch left in the card for a test to duplicate, and no
// way for the card to drift from the rule.
//
// SCOPE — presentation only. It decides what is offered, never what may be
// charged. Execution authority stays with decideExecutionPricingPermission and
// the prepared attempt remains the sole execution amount.

export type ReadyControlPermission = {
  canRun: boolean;
  blocked: boolean;
};

export type SessionPaymentPresentation = {
  // The persisted attempt's status panel. Visible whenever an attempt exists.
  panelVisible: boolean;
  // The READY branch's "Charge client" section, including Run charge.
  runChargeVisible: boolean;
  // "<service> is free · No payment required." The service name comes back
  // narrowed so the card renders copy without re-testing `kind` — a narrowing
  // guard beside the decision is one more branch that could drift.
  freeNoticeVisible: boolean;
  freeServiceName: string | null;
  // "The payment amount could not be confirmed. Refresh and try again."
  unavailableExplanationVisible: boolean;
  // Practitioner copy for missing/ambiguous pricing, already resolved here.
  unresolvedExplanationVisible: boolean;
  unresolvedExplanation: string | null;
  // Retained for callers that only need the permission question.
  readyControl: ReadyControlPermission;
};

export function decideReadyControlPermission(
  attemptStatus: string | null,
  amountResult: SessionPaymentAmountResult | null,
): ReadyControlPermission {
  if (attemptStatus !== "ready") {
    // pending_stripe / succeeded are transaction state; any other status has
    // no money-moving control here at all.
    return { canRun: false, blocked: false };
  }
  const canRun = amountResult?.kind === "resolved";
  return { canRun, blocked: !canRun };
}

export function decideSessionPaymentPresentation(input: {
  attemptStatus: string | null;
  amountResult: SessionPaymentAmountResult | null;
  // Eligibility-driven, and independent of pricing. False whenever an attempt
  // is active, which is exactly why the explanations could not hang off it
  // alone: the reason vanished precisely when a blocked ready attempt showed.
  showPrepareForm: boolean;
}): SessionPaymentPresentation {
  const { attemptStatus, amountResult, showPrepareForm } = input;
  const readyControl = decideReadyControlPermission(attemptStatus, amountResult);

  const settledOrInFlight = attemptStatus !== null && attemptStatus !== "ready";
  const explain = showPrepareForm || readyControl.blocked;

  // A settled or in-flight attempt is money that moved; never overwrite it
  // with "No payment required".
  const freeNoticeVisible =
    amountResult?.kind === "free" && !settledOrInFlight;
  const isUnresolved =
    amountResult !== null &&
    amountResult.kind !== "resolved" &&
    amountResult.kind !== "free";
  const unresolvedExplanationVisible = explain && isUnresolved;

  return {
    panelVisible: attemptStatus !== null,
    runChargeVisible: readyControl.canRun,
    freeNoticeVisible,
    freeServiceName:
      amountResult?.kind === "free" ? amountResult.serviceName : null,
    unavailableExplanationVisible: explain && amountResult === null,
    unresolvedExplanationVisible,
    unresolvedExplanation:
      unresolvedExplanationVisible && isUnresolved
        ? unresolvedAmountMessage(amountResult)
        : null,
    readyControl,
  };
}

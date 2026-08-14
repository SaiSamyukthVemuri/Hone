import {
  unresolvedAmountMessage,
  type SessionPaymentAmountResult,
} from "@/lib/billing/session-payment-amount";

// Reviews 3780286321 / 3780371682 / 3780456783 / 3780573779.
//
// THE SESSION-PAYMENT CARD'S PRESENTATION DECISION — one value per question,
// each of them the value the component actually consumes.
//
// Two questions, which were originally conflated:
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
//      withdraw it. Execution refuses every one of those anyway, so this is UI
//      truth: without it the practitioner saw a runnable-looking control and
//      discovered the block only after clicking.
//
// Current pricing governs whether a READY attempt may still ACT. It never
// erases money that has already MOVED: pending_stripe and succeeded keep their
// panel, receipt and refund controls under every pricing state.
//
// ONE REPRESENTATION PER DECISION — the point of review 3780573779.
// This module previously exported the ready decision twice: as
// `runChargeVisible` and again as `readyControl.canRun`. The tests asserted
// the first; the card consumed the second. They agreed only because one was
// derived from the other, so a later edit could make them diverge with the
// matrix still green and the UI doing the opposite. There is now exactly one
// consumable field per question, and `runChargeVisible` travels under that
// same name from here through AttemptStatusPanel into ReadyPanel's render
// gate — no alias, no wrapper, no second boolean.
//
// The whole render decision lives here, not just the permission flag, because
// this repository's vitest setup renders no components (node environment,
// `tests/**/*.test.ts`, no jsdom). A test cannot assert on rendered output, so
// if the card computed its own branches a test could only ever duplicate them
// and prove the duplicate self-consistent. The card holds no branch of its own.
//
// SCOPE — presentation only. It decides what is offered, never what may be
// charged. Execution authority stays with decideExecutionPricingPermission and
// the prepared attempt remains the sole execution amount.

export type SessionPaymentPresentation = {
  // The persisted attempt's status panel. Visible whenever an attempt exists,
  // regardless of what current pricing says.
  panelVisible: boolean;
  // THE READY money-control decision. The single authority: tested here,
  // consumed by the card, threaded unchanged into ReadyPanel's render gate.
  runChargeVisible: boolean;
  // "<service> is free · No payment required." The service name comes back
  // narrowed so the card renders copy without re-testing `kind` — a narrowing
  // guard beside the decision is one more branch that could drift.
  freeNoticeVisible: boolean;
  freeServiceName: string | null;
  // "The payment amount could not be confirmed. Refresh and try again."
  unavailableExplanationVisible: boolean;
  // Practitioner copy for missing/ambiguous pricing, already resolved here.
  // Null means "do not render", so there is no separate visibility boolean to
  // fall out of step with the text.
  unresolvedExplanation: string | null;
};

export function decideSessionPaymentPresentation(input: {
  attemptStatus: string | null;
  amountResult: SessionPaymentAmountResult | null;
  // Eligibility-driven, and independent of pricing. False whenever an attempt
  // is active, which is exactly why the explanations could not hang off it
  // alone: the reason vanished precisely when a blocked ready attempt showed.
  showPrepareForm: boolean;
}): SessionPaymentPresentation {
  const { attemptStatus, amountResult, showPrepareForm } = input;

  const isReady = attemptStatus === "ready";
  // `ready` is the only status carrying a money-moving control; pending_stripe
  // and succeeded are transaction state and are never gated on today's price.
  const runChargeVisible = isReady && amountResult?.kind === "resolved";
  const readyBlocked = isReady && !runChargeVisible;

  const settledOrInFlight = attemptStatus !== null && !isReady;
  const explain = showPrepareForm || readyBlocked;

  const isUnresolved =
    amountResult !== null &&
    amountResult.kind !== "resolved" &&
    amountResult.kind !== "free";

  return {
    panelVisible: attemptStatus !== null,
    runChargeVisible,
    // A settled or in-flight attempt is money that moved; never overwrite it
    // with "No payment required".
    freeNoticeVisible: amountResult?.kind === "free" && !settledOrInFlight,
    freeServiceName:
      amountResult?.kind === "free" ? amountResult.serviceName : null,
    unavailableExplanationVisible: explain && amountResult === null,
    unresolvedExplanation:
      explain && isUnresolved ? unresolvedAmountMessage(amountResult) : null,
  };
}

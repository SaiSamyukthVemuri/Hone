import {
  unresolvedAmountMessage,
  type ResolvedSessionPaymentAmount,
  type SessionPaymentAmountResult,
} from "@/lib/billing/session-payment-amount";

// Reviews 3780286321 / 3780371682 / 3780456783 / 3780573779.
//
// THE SESSION-PAYMENT CARD'S PRICING-DEPENDENT PRESENTATION DECISION — one
// value per question, each of them the value the component actually consumes.
//
// SCOPE, stated precisely. This module owns every presentation decision that
// depends on CURRENT PRICING. It does not own the card's other conditionals,
// and should not: whether an active persisted attempt exists, status-specific
// panel dispatch, the previous-terminal-attempt callout, the transient
// prepareJustSucceeded state, the eligibility BlockedPanel and local
// submit/pending/error interaction all remain card-local, because none of them
// interprets a price. An earlier comment here claimed "the complete render
// decision" and that "the card holds no branch of its own"; that was over-broad
// and is corrected — the claim is now exactly what is true.
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
// The whole PRICING-DEPENDENT decision lives here, not just the permission
// flag, because this repository's vitest setup renders no components (node
// environment, `tests/**/*.test.ts`, no jsdom). A test cannot assert on
// rendered output, so if the card interpreted pricing itself a test could only
// duplicate that interpretation and prove the duplicate self-consistent.
//
// Review 3780746701 was the INVERSE of the duplicate-authority findings: the
// prepare-form decision was never exported at all. The card derived its own
// `resolvedAmount` and rendered `showPrepareForm && resolvedAmount`, so the
// matrix could be fully green while that branch was wrong. One decision
// exported twice and one decision never exported break the same law — anything
// a test asserts must be the value the component consumes.
//
// SCOPE — presentation only. It decides what is offered, never what may be
// charged. Execution authority stays with decideExecutionPricingPermission and
// the prepared attempt remains the sole execution amount.

export type SessionPaymentPresentation = {
  // NOTE ON WHAT IS *NOT* HERE — panel visibility.
  //
  // "A persisted active attempt is always visible" needs no presentation
  // field: it is exactly "an attempt exists", which the card already knows.
  // A `panelVisible` boolean restating `attemptStatus !== null` was a second
  // representation of one fact, and the card had to write
  // `presentation.panelVisible && activeAttempt` anyway for narrowing — so the
  // two could drift apart. The card now renders on `activeAttempt` alone.

  // THE READY money-control decision. The single authority: tested here,
  // consumed by the card, threaded unchanged into ReadyPanel's render gate.
  runChargeVisible: boolean;
  // The prepare form, as ONE value: the authoritative resolved amount when the
  // form should render, null when it should not. Deliberately NOT
  // `prepareFormVisible` + `prepareFormAmount`, which would recreate exactly
  // the pair this PR has already collapsed twice.
  prepareFormAmount: ResolvedSessionPaymentAmount | null;
  // The free notice, as ONE value: the service name when the notice should
  // render, null when it should not.
  //
  // This was `freeNoticeVisible` + `freeServiceName`, and those two ALREADY
  // disagreed: the name was populated for any $0 service, while visibility
  // additionally required !settledOrInFlight — so a succeeded attempt on a
  // now-free service had a name with the notice correctly hidden. Nothing
  // rendered wrongly, because the card only read the name inside the
  // visibility branch, but that is the same "two values, one question" shape
  // that produced review 3780573779. One nullable value cannot disagree with
  // itself.
  freeNoticeServiceName: string | null;
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

  // Preparation requires eligibility AND a currently resolved price. Free,
  // missing, ambiguous and unavailable pricing all withhold the form; the
  // explanations below say why.
  const prepareFormAmount =
    showPrepareForm && amountResult?.kind === "resolved" ? amountResult : null;

  return {
    runChargeVisible,
    prepareFormAmount,
    // A settled or in-flight attempt is money that moved; never overwrite it
    // with "No payment required".
    freeNoticeServiceName:
      amountResult?.kind === "free" && !settledOrInFlight
        ? amountResult.serviceName
        : null,
    unavailableExplanationVisible: explain && amountResult === null,
    unresolvedExplanation:
      explain && isUnresolved ? unresolvedAmountMessage(amountResult) : null,
  };
}

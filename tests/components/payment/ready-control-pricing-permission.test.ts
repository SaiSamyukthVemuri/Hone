import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideSessionPaymentPresentation } from "@/lib/billing/ready-control-permission";

// Review 3780286321: READY-CONTROL PERMISSION.
//
// `ready` is the only attempt status carrying a money-moving control, and it
// may expose that control ONLY while current authoritative pricing is
// `resolved`.
//
// The previous gate was free-only, so an attempt whose service price had since
// been cleared to NULL, whose custom pricing had become ambiguous, or whose
// pricing read had failed still rendered Run charge. Execution already refuses
// all of those, money safety was intact, but the practitioner saw an
// apparently runnable control and only discovered the block after submitting.
// Worse, the pricing explanations were gated on `showPrepareForm`, which is
// false whenever an attempt is active, so the explanation was suppressed
// exactly when the stale ready attempt was on screen.
//
// The card is a client component whose branches are pure functions of
// (activeAttempt.status, amountResult.kind), so this proves the state machine
// by evaluating those conditions directly, then pins the source wiring.

const CARD = readFileSync(
  join(process.cwd(), "components/session-payment-prepare-card.tsx"),
  "utf8",
);

const PERM = readFileSync(
  join(process.cwd(), "lib/billing/ready-control-permission.ts"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\{\/\*/.test(l))
    .join("\n");
}

type Kind =
  | "resolved"
  | "free"
  | "missing_price"
  | "missing_service"
  | "ambiguous_custom_pricing";

// No reconstruction. Review 3780456783: a test that rebuilds the card's
// conditions proves only that the rebuild is self-consistent. The card now
// reads these exact fields and holds no branch of its own, so exercising the
// decision IS exercising the card's render choice.
function amount(kind: Kind | null) {
  if (kind === null) return null;
  if (kind === "resolved")
    return {
      kind,
      amountCents: 12_000,
      source: "service_price",
      serviceName: "Electrolysis",
      durationMinutes: 30,
      customPricingNote: null,
    } as never;
  if (kind === "free")
    return { kind, serviceName: "Consultation", durationMinutes: 30 } as never;
  if (kind === "missing_service") return { kind } as never;
  if (kind === "missing_price")
    return { kind, serviceName: "Electrolysis" } as never;
  return {
    kind,
    serviceName: "Electrolysis",
    candidateCents: [9_000, 12_000],
  } as never;
}

function view(status: string | null, kind: Kind | null) {
  return decideSessionPaymentPresentation({
    attemptStatus: status,
    amountResult: amount(kind),
    // An active attempt always makes the prepare form false.
    showPrepareForm: status === null,
  });
}

describe("a persisted attempt stays visible; only the control is withdrawn", () => {
  it("1 READY + resolved => prepared summary visible, Run charge visible", () => {
    const v = view("ready", "resolved");
    expect(v.runChargeVisible).toBe(true);
    expect(v.unresolvedExplanation).toBeNull();
    expect(v.unavailableExplanationVisible).toBe(false);
  });

  it("2 READY + free => summary visible, no Run charge, No payment required", () => {
    const v = view("ready", "free");
    expect(v.runChargeVisible).toBe(false);
    expect(v.freeNoticeServiceName).toBe("Consultation");
  });

  it("3 READY + missing_price => summary visible, no Run charge, pricing explanation", () => {
    const v = view("ready", "missing_price");
    expect(v.runChargeVisible).toBe(false);
    expect(v.unresolvedExplanation).toMatch(/No price is configured/i);
  });

  it("4 READY + missing_service => summary visible, no Run charge, pricing explanation", () => {
    const v = view("ready", "missing_service");
    expect(v.runChargeVisible).toBe(false);
    expect(v.unresolvedExplanation).toMatch(/no booked service/i);
  });

  it("5 READY + ambiguous_custom_pricing => summary visible, no Run charge, ambiguity explained", () => {
    const v = view("ready", "ambiguous_custom_pricing");
    expect(v.runChargeVisible).toBe(false);
    expect(v.unresolvedExplanation).toMatch(/more than one current client-specific price/i);
  });

  it("6 READY + pricing read failure => summary visible, no Run charge, unavailable explained", () => {
    const v = view("ready", null);
    expect(v.runChargeVisible).toBe(false);
    expect(v.unavailableExplanationVisible).toBe(true);
  });

  it("7 PENDING_STRIPE + pricing failure => Processing panel preserved", () => {
    for (const k of [null, "missing_price", "ambiguous_custom_pricing", "free"] as const) {
      const v = view("pending_stripe", k as Kind | null);
      expect(v.runChargeVisible, String(k)).toBe(false); // ready-only control
      expect(v.freeNoticeServiceName, String(k)).toBeNull(); // never claims free
    }
  });

  it("8 SUCCEEDED + pricing failure => Paid / receipt / refund preserved", () => {
    for (const k of [null, "missing_price", "ambiguous_custom_pricing", "free"] as const) {
      const v = view("succeeded", k as Kind | null);
      expect(v.freeNoticeServiceName, String(k)).toBeNull();
    }
  });

  it("9 THE FINDING: a SINGLE ready attempt with unresolved pricing stays visible", () => {
    // AttemptHistory only renders with more than one attempt, so suppressing
    // the panel made the only prepared payment appear to vanish while it still
    // blocked preparation.
    for (const k of ["free", "missing_price", "missing_service", "ambiguous_custom_pricing", null] as const) {
      const v = view("ready", k as Kind | null);

      expect(v.runChargeVisible, `${String(k)} must withdraw the control`).toBe(false);
      expect(
        v.freeNoticeServiceName !== null ||
          v.unresolvedExplanation !== null ||
          v.unavailableExplanationVisible,
        `${String(k)} must explain itself`,
      ).toBe(true);
    }
    expect(view("ready", "resolved").runChargeVisible).toBe(true);
  });

  // ---- Review 3780746701: the prepare-form decision is exported and tested.

  it("PF1 no attempt + eligible + resolved => prepareFormAmount is the resolved object", () => {
    const v = view(null, "resolved");
    expect(v.prepareFormAmount).not.toBeNull();
    expect(v.prepareFormAmount?.kind).toBe("resolved");
    expect(v.prepareFormAmount?.amountCents).toBe(12_000);
  });

  it("PF2 no attempt + free => no prepare form, free notice instead", () => {
    const v = view(null, "free");
    expect(v.prepareFormAmount).toBeNull();
    expect(v.freeNoticeServiceName).toBe("Consultation");
  });

  it("PF3 no attempt + missing_price / missing_service / ambiguous => no form, explanation", () => {
    for (const k of ["missing_price", "missing_service", "ambiguous_custom_pricing"] as const) {
      const v = view(null, k);
      expect(v.prepareFormAmount, k).toBeNull();
      expect(v.unresolvedExplanation, k).not.toBeNull();
    }
  });

  it("PF4 no attempt + pricing unavailable => no form, unavailable explanation", () => {
    const v = view(null, null);
    expect(v.prepareFormAmount).toBeNull();
    expect(v.unavailableExplanationVisible).toBe(true);
  });

  it("PF5 an ACTIVE attempt never yields a prepare form, whatever the price", () => {
    for (const status of ["ready", "pending_stripe", "succeeded"] as const) {
      for (const k of ["resolved", "free", "missing_price", "ambiguous_custom_pricing", null] as const) {
        expect(
          view(status, k as Kind | null).prepareFormAmount,
          `${status}/${String(k)}`,
        ).toBeNull();
      }
    }
    // and the ready transaction laws are unaffected by that
    expect(view("ready", "resolved").runChargeVisible).toBe(true);
    expect(view("ready", "free").runChargeVisible).toBe(false);
  });

  it("PF6 ineligible => no prepare form even with a resolved price", () => {
    const v = decideSessionPaymentPresentation({
      attemptStatus: null,
      amountResult: amount("resolved"),
      showPrepareForm: false, // eligibility/prepareJustSucceeded upstream
    });
    expect(v.prepareFormAmount).toBeNull();
  });

  it("no attempt: the prepare-side behaviour is unchanged", () => {

    expect(view(null, "missing_price").unresolvedExplanation).not.toBeNull();
    expect(view(null, null).unavailableExplanationVisible).toBe(true);
    expect(view(null, "free").freeNoticeServiceName).not.toBeNull();
  });
});

describe("source wiring", () => {
  it("the card reads the decision and holds no branch of its own", () => {
    expect(CARD).toMatch(/decideSessionPaymentPresentation\(/);
    expect(CARD).toMatch(/\{activeAttempt && \(/);
    expect(CARD).toMatch(/\{presentation\.freeNoticeServiceName !== null && \(/);
    expect(CARD).toMatch(/\{presentation\.unavailableExplanationVisible && \(/);
    expect(CARD).toMatch(/\{presentation\.unresolvedExplanation !== null && \(/);
    // the old reconstructed locals are gone
    const code = codeOnly(CARD);
    expect(code).not.toMatch(/const isFreeNow =/);
    expect(code).not.toMatch(/const settledOrInFlightAttempt =/);
    expect(code).not.toMatch(/const readyAttemptBlocked =/);
    // the panel is no longer suppressed by pricing
    expect(code).not.toMatch(/activeAttempt && !readyAttemptBlocked/);
  });

  it("the READY charge section is the only thing pricing withdraws", () => {
    expect(CARD).toMatch(/runChargeVisible=\{presentation\.runChargeVisible\}/);
    expect(CARD).toMatch(/runChargeVisible=\{runChargeVisible\}/);
    expect(CARD).toMatch(/\{runChargeVisible && \(/);
    expect(CARD).toMatch(/data-testid="ready-charge-section"/);
    // PaymentSummaryCard for the prepared attempt sits OUTSIDE that gate
    const ready = CARD.slice(CARD.indexOf("function ReadyPanel("));
    const summaryIdx = ready.indexOf("<PaymentSummaryCard");
    const gateIdx = ready.indexOf("{runChargeVisible && (");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(summaryIdx);
  });

  it("execution authority and prepared-amount semantics are untouched", () => {
    // PrepareForm still requires a strictly `resolved` amount, the rule moved
    // into the presentation decision (review 3780746701), so assert it there.
    expect(PERM).toMatch(
      /showPrepareForm && amountResult\?\.kind === "resolved" \? amountResult : null/,
    );
    const amountRefs = codeOnly(CARD).match(/\w*amount_cents/g) ?? [];
    expect(new Set(amountRefs)).toEqual(new Set(["expected_amount_cents"]));
  });
});

describe("exactly ONE ready-control authority", () => {
  // Review 3780573779. The module used to export the ready decision twice,
  // as `runChargeVisible` and again as `readyControl.canRun`. The tests
  // asserted the first, the card consumed the second, and they agreed only
  // because one was derived from the other. A later edit could have made them
  // diverge with this matrix still green and the UI doing the opposite.
  it("the panel CANNOT be gated on pricing, there is no field to do it with", () => {
    // Census outcome A. "A persisted active attempt is always visible" needs no
    // presentation field: it is exactly "an attempt exists". A `panelVisible`
    // boolean restating that was a second representation the card had to
    // combine with `activeAttempt` anyway, so the two could drift. Removing it
    // makes suppression-by-pricing unrepresentable rather than merely absent.
    expect(codeOnly(PERM)).not.toMatch(/panelVisible/);
    expect(codeOnly(CARD)).not.toMatch(/panelVisible/);
    expect(CARD).toMatch(/\{activeAttempt && \(\s*\n?\s*<AttemptStatusPanel/);
  });

  it("the free notice is ONE value, so presence cannot disagree with content", () => {
    // Census outcome B. `freeNoticeVisible` + `freeServiceName` already
    // disagreed: the name was set for any $0 service while visibility also
    // required !settledOrInFlight, so a succeeded attempt on a now-free
    // service carried a name with the notice correctly hidden.
    expect(codeOnly(PERM)).not.toMatch(/freeNoticeVisible/);
    expect(codeOnly(PERM)).not.toMatch(/freeServiceName\b/);
    expect(codeOnly(CARD)).not.toMatch(/freeNoticeVisible/);
    expect(PERM).toMatch(/freeNoticeServiceName:\s*\n?\s*amountResult\?\.kind === "free" && !settledOrInFlight/);
    expect(CARD).toMatch(/presentation\.freeNoticeServiceName !== null/);
    // the SAME value supplies the rendered name
    expect(CARD).toMatch(/\{presentation\.freeNoticeServiceName\} is free/);
  });

  it("every presentation field is consumed by the card", () => {
    // No field may exist that nothing reads: an unconsumed value is a second
    // authority waiting to happen.
    // Scope extraction to the PRESENTATION type. A bare /^  (\w+):/ also swept
    // the input object's fields (attemptStatus, amountResult, showPrepareForm),
    // which the card supplies rather than consumes.
    const typeBlock = PERM.slice(
      PERM.indexOf("export type SessionPaymentPresentation = {"),
      PERM.indexOf("export function decideSessionPaymentPresentation"),
    );
    expect(typeBlock.length).toBeGreaterThan(100);
    const fields = [...typeBlock.matchAll(/^  (\w+):/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(codeOnly(CARD), `${f} must be consumed`).toMatch(
        new RegExp(`presentation\\.${f}`),
      );
    }
  });

  it("the card makes NO pricing-dependent decision of its own", () => {
    // Review 3780746701 was the inverse of the duplicate findings: the
    // prepare-form decision was never exported, so the card interpreted
    // pricing itself and only a source regex covered it. This asserts the
    // direction that census missed.
    const code = codeOnly(CARD);
    for (const token of [
      /const resolvedAmount/,
      /kind === "resolved"/,
      /kind === "free"/,
      /"missing_price"/,
      /"missing_service"/,
      /"ambiguous_custom_pricing"/,
      /unresolvedAmountMessage\(/,
      /isFreeNow/,
      /readyAttemptIsNowFree/,
      /readyControl/,
      /canRun/,
    ]) {
      expect(code, `card must not interpret pricing: ${token}`).not.toMatch(token);
    }
    // it may still PASS pricing data into the decision
    expect(code).toMatch(/amountResult: amountResult \?\? null/);
  });

  it("the prepare form is ONE value carrying both presence and payload", () => {
    expect(codeOnly(PERM)).not.toMatch(/prepareFormVisible/);
    expect(PERM).toMatch(
      /const prepareFormAmount =\s*\n?\s*showPrepareForm && amountResult\?\.kind === "resolved" \? amountResult : null/,
    );
    expect(CARD).toMatch(/\{presentation\.prepareFormAmount !== null && eligibleDetails && \(/);
    expect(CARD).toMatch(/amount=\{presentation\.prepareFormAmount\}/);
  });

  it("the presentation model exposes no second ready-control representation", () => {
    expect(codeOnly(PERM)).not.toMatch(/readyControl/);
    expect(codeOnly(PERM)).not.toMatch(/ReadyControlPermission/);
    expect(codeOnly(PERM)).not.toMatch(/decideReadyControlPermission/);
    expect(codeOnly(PERM)).not.toMatch(/canRun/);
    // exactly one place computes it
    expect((codeOnly(PERM).match(/runChargeVisible/g) ?? []).length).toBeGreaterThan(0);
    expect(codeOnly(PERM)).toMatch(
      /const runChargeVisible = isReady && amountResult\?\.kind === "resolved"/,
    );
  });

  it("the card reads that one field and never a second decision path", () => {
    const code = codeOnly(CARD);
    expect(code).not.toMatch(/readyControl/);
    expect(code).not.toMatch(/decideReadyControlPermission/);
    expect(code).not.toMatch(/canRun/);
    expect(code).toMatch(/runChargeVisible=\{presentation\.runChargeVisible\}/);
  });

  it("the SAME name travels from the decision to the render gate", () => {
    // presentation -> AttemptStatusPanel -> ReadyPanel -> {runChargeVisible && (
    const card = codeOnly(CARD);
    const fromPresentation = card.indexOf("runChargeVisible={presentation.runChargeVisible}");
    const forwarded = card.indexOf("runChargeVisible={runChargeVisible}");
    const gate = card.indexOf("{runChargeVisible && (");
    expect(fromPresentation).toBeGreaterThan(-1);
    expect(forwarded).toBeGreaterThan(fromPresentation);
    expect(gate).toBeGreaterThan(forwarded);
    // and the charge section is what that gate controls
    const gated = card.slice(gate, gate + 400);
    expect(gated).toMatch(/data-testid="ready-charge-section"/);
  });

  it("the persisted summary is NOT inside that gate", () => {
    const ready = CARD.slice(CARD.indexOf("function ReadyPanel("));
    const summaryIdx = ready.indexOf("<PaymentSummaryCard");
    const gateIdx = ready.indexOf("{runChargeVisible && (");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(summaryIdx);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideSessionPaymentPresentation } from "@/lib/billing/ready-control-permission";

// Review 3780286321 — READY-CONTROL PERMISSION.
//
// `ready` is the only attempt status carrying a money-moving control, and it
// may expose that control ONLY while current authoritative pricing is
// `resolved`.
//
// The previous gate was free-only, so an attempt whose service price had since
// been cleared to NULL, whose custom pricing had become ambiguous, or whose
// pricing read had failed still rendered Run charge. Execution already refuses
// all of those — money safety was intact — but the practitioner saw an
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
    expect(v.panelVisible).toBe(true);
    expect(v.runChargeVisible).toBe(true);
    expect(v.unresolvedExplanationVisible).toBe(false);
    expect(v.unavailableExplanationVisible).toBe(false);
  });

  it("2 READY + free => summary visible, no Run charge, No payment required", () => {
    const v = view("ready", "free");
    expect(v.panelVisible).toBe(true);
    expect(v.runChargeVisible).toBe(false);
    expect(v.freeNoticeVisible).toBe(true);
    expect(v.freeServiceName).toBe("Consultation");
  });

  it("3 READY + missing_price => summary visible, no Run charge, pricing explanation", () => {
    const v = view("ready", "missing_price");
    expect(v.panelVisible).toBe(true);
    expect(v.runChargeVisible).toBe(false);
    expect(v.unresolvedExplanation).toMatch(/No price is configured/i);
  });

  it("4 READY + missing_service => summary visible, no Run charge, pricing explanation", () => {
    const v = view("ready", "missing_service");
    expect(v.panelVisible).toBe(true);
    expect(v.runChargeVisible).toBe(false);
    expect(v.unresolvedExplanation).toMatch(/no booked service/i);
  });

  it("5 READY + ambiguous_custom_pricing => summary visible, no Run charge, ambiguity explained", () => {
    const v = view("ready", "ambiguous_custom_pricing");
    expect(v.panelVisible).toBe(true);
    expect(v.runChargeVisible).toBe(false);
    expect(v.unresolvedExplanation).toMatch(/more than one current client-specific price/i);
  });

  it("6 READY + pricing read failure => summary visible, no Run charge, unavailable explained", () => {
    const v = view("ready", null);
    expect(v.panelVisible).toBe(true);
    expect(v.runChargeVisible).toBe(false);
    expect(v.unavailableExplanationVisible).toBe(true);
  });

  it("7 PENDING_STRIPE + pricing failure => Processing panel preserved", () => {
    for (const k of [null, "missing_price", "ambiguous_custom_pricing", "free"] as const) {
      const v = view("pending_stripe", k as Kind | null);
      expect(v.panelVisible, String(k)).toBe(true);
      expect(v.runChargeVisible, String(k)).toBe(false); // ready-only control
      expect(v.freeNoticeVisible, String(k)).toBe(false); // never claims free
    }
  });

  it("8 SUCCEEDED + pricing failure => Paid / receipt / refund preserved", () => {
    for (const k of [null, "missing_price", "ambiguous_custom_pricing", "free"] as const) {
      const v = view("succeeded", k as Kind | null);
      expect(v.panelVisible, String(k)).toBe(true);
      expect(v.freeNoticeVisible, String(k)).toBe(false);
    }
  });

  it("9 THE FINDING: a SINGLE ready attempt with unresolved pricing stays visible", () => {
    // AttemptHistory only renders with more than one attempt, so suppressing
    // the panel made the only prepared payment appear to vanish while it still
    // blocked preparation.
    for (const k of ["free", "missing_price", "missing_service", "ambiguous_custom_pricing", null] as const) {
      const v = view("ready", k as Kind | null);
      expect(v.panelVisible, `${String(k)} must keep the prepared summary`).toBe(true);
      expect(v.runChargeVisible, `${String(k)} must withdraw the control`).toBe(false);
      expect(
        v.freeNoticeVisible ||
          v.unresolvedExplanationVisible ||
          v.unavailableExplanationVisible,
        `${String(k)} must explain itself`,
      ).toBe(true);
    }
    expect(view("ready", "resolved").runChargeVisible).toBe(true);
  });

  it("no attempt: the prepare-side behaviour is unchanged", () => {
    expect(view(null, "resolved").panelVisible).toBe(false);
    expect(view(null, "missing_price").unresolvedExplanationVisible).toBe(true);
    expect(view(null, null).unavailableExplanationVisible).toBe(true);
    expect(view(null, "free").freeNoticeVisible).toBe(true);
  });
});

describe("source wiring", () => {
  it("the card reads the decision and holds no branch of its own", () => {
    expect(CARD).toMatch(/decideSessionPaymentPresentation\(/);
    expect(CARD).toMatch(/\{presentation\.panelVisible && activeAttempt && \(/);
    expect(CARD).toMatch(/\{presentation\.freeNoticeVisible && \(/);
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
    expect(CARD).toMatch(/canRun=\{readyControl\.canRun\}/);
    expect(CARD).toMatch(/\{canRun && \(/);
    expect(CARD).toMatch(/data-testid="ready-charge-section"/);
    // PaymentSummaryCard for the prepared attempt sits OUTSIDE that gate
    const ready = CARD.slice(CARD.indexOf("function ReadyPanel("));
    const summaryIdx = ready.indexOf("<PaymentSummaryCard");
    const gateIdx = ready.indexOf("{canRun && (");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(summaryIdx);
  });

  it("execution authority and prepared-amount semantics are untouched", () => {
    expect(CARD).toMatch(/amountResult\.kind === "resolved" \? amountResult : null/);
    const amountRefs = codeOnly(CARD).match(/\w*amount_cents/g) ?? [];
    expect(new Set(amountRefs)).toEqual(new Set(["expected_amount_cents"]));
  });
});

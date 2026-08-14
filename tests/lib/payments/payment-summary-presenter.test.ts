import { describe, expect, it } from "vitest";
import {
  maskReceiptEmail,
  humanChargeFailure,
  derivePaymentSummary,
  deriveReceiptLine,
  technicalRowsForAttempt,
  formatCadFromCents,
} from "@/lib/payments/payment-summary-presenter";
import type { SessionPaymentExistingAttemptSummary } from "@/lib/billing/session-payment-types";

// Pure presenter for the compact practitioner payment card. No PHI in fixtures
// (synthetic emails/ids only). These lock the privacy + state contract that the
// component relies on.

function attempt(
  over: Partial<SessionPaymentExistingAttemptSummary> = {},
): SessionPaymentExistingAttemptSummary {
  return {
    id: "att_test",
    status: "succeeded",
    amountCents: 22500,
    createdAt: "2026-07-12T19:03:00Z",
    stripePaymentIntentId: "pi_test",
    stripeChargeId: "ch_test",
    chargedAt: "2026-07-12T19:03:00Z",
    failedAt: null,
    failureCode: null,
    failureMessageSafe: null,
    receiptStatus: null,
    receiptSentAt: null,
    receiptEmailTo: null,
    receiptFailureCode: null,
    receiptFailureMessageSafe: null,
    refundStatus: null,
    refundAmountCents: null,
    refundedAt: null,
    stripeRefundId: null,
    refundFailureCode: null,
    refundFailureMessageSafe: null,
    ...over,
  };
}

describe("maskReceiptEmail: never reveals the full address", () => {
  it("masks the local part, keeps first char + full domain (min three bullets)", () => {
    expect(maskReceiptEmail("a@example.com")).toBe("a•••@example.com");
    expect(maskReceiptEmail("chloe@example.com")).toBe("c••••@example.com");
    expect(maskReceiptEmail("jo@studio.care")).toBe("j•••@studio.care");
  });
  it("bullet count grows with the local part (never fewer than three)", () => {
    // "practitioner" = 12 chars → first char + 11 bullets.
    expect(maskReceiptEmail("practitioner@example.com")).toBe(
      `p${"•".repeat(11)}@example.com`,
    );
  });
  it("returns '' for a missing / blank / implausible value (caller falls back)", () => {
    expect(maskReceiptEmail(null)).toBe("");
    expect(maskReceiptEmail(undefined)).toBe("");
    expect(maskReceiptEmail("   ")).toBe("");
    expect(maskReceiptEmail("not-an-email")).toBe("");
    expect(maskReceiptEmail("@example.com")).toBe("");
    expect(maskReceiptEmail("a@")).toBe("");
    expect(maskReceiptEmail("a@localhost")).toBe(""); // no dot in domain
    expect(maskReceiptEmail("a b@example.com")).toBe(""); // whitespace
  });
  it("never returns the original full local part", () => {
    const out = maskReceiptEmail("secretname@example.com");
    expect(out).not.toContain("secretname");
    expect(out.startsWith("s")).toBe(true);
  });
});

describe("humanChargeFailure: practitioner-friendly, never the raw code", () => {
  it("maps declined / expired / insufficient families to safe copy", () => {
    expect(humanChargeFailure("card_declined")).toMatch(/declined/i);
    expect(humanChargeFailure("generic_decline")).toMatch(/declined/i);
    expect(humanChargeFailure("expired_card")).toMatch(/expired/i);
    expect(humanChargeFailure("insufficient_funds")).toMatch(/insufficient/i);
  });
  it("falls back to a generic message for unknown / null codes", () => {
    expect(humanChargeFailure(null)).toMatch(/could not be completed/i);
    expect(humanChargeFailure("some_internal_thing_xyz")).toMatch(
      /could not be completed/i,
    );
  });
  it("never echoes the raw code back", () => {
    expect(humanChargeFailure("do_not_honor")).not.toContain("do_not_honor");
    expect(humanChargeFailure("weird_code_123")).not.toContain("weird_code_123");
  });
});

describe("derivePaymentSummary: one current headline per state", () => {
  it("null attempt → Not charged", () => {
    expect(derivePaymentSummary(null)).toMatchObject({
      kind: "not_charged",
      headline: "Not charged",
      amountCents: null,
    });
  });
  it("ready / processing / paid", () => {
    expect(derivePaymentSummary(attempt({ status: "ready" }))).toMatchObject({
      kind: "ready",
      headline: "Ready to charge",
    });
    expect(
      derivePaymentSummary(attempt({ status: "pending_stripe" })),
    ).toMatchObject({ kind: "processing", headline: "Payment processing" });
    expect(derivePaymentSummary(attempt())).toMatchObject({
      kind: "paid",
      headline: "Paid",
      amountCents: 22500,
    });
  });
  it("paid but receipt failed still reads Paid (charge success ≠ receipt delivery)", () => {
    expect(
      derivePaymentSummary(attempt({ receiptStatus: "failed" })),
    ).toMatchObject({ kind: "paid_receipt_failed", headline: "Paid" });
  });
  it("refunded / refund pending promote the headline", () => {
    expect(
      derivePaymentSummary(attempt({ refundStatus: "succeeded" })),
    ).toMatchObject({ kind: "refunded", headline: "Refunded" });
    expect(
      derivePaymentSummary(attempt({ refundStatus: "pending_stripe" })),
    ).toMatchObject({ kind: "refund_pending" });
  });
  it("failed → issue tone", () => {
    expect(
      derivePaymentSummary(attempt({ status: "failed" })),
    ).toMatchObject({ kind: "failed", tone: "issue" });
  });
});

describe("deriveReceiptLine: masked, delivery-status separate", () => {
  it("sent → masked address (or plain 'sent' when no stored email)", () => {
    expect(
      deriveReceiptLine({ receiptStatus: "sent", receiptEmailTo: "chloe@example.com" }),
    ).toEqual({ kind: "sent", masked: "c••••@example.com" });
    expect(
      deriveReceiptLine({ receiptStatus: "sent", receiptEmailTo: null }),
    ).toEqual({ kind: "sent", masked: null });
  });
  it("failed / sending / none", () => {
    expect(
      deriveReceiptLine({ receiptStatus: "failed", receiptEmailTo: null }).kind,
    ).toBe("failed");
    expect(
      deriveReceiptLine({ receiptStatus: "sending", receiptEmailTo: null }).kind,
    ).toBe("sending");
    expect(
      deriveReceiptLine({ receiptStatus: null, receiptEmailTo: null }).kind,
    ).toBe("none");
  });
});

describe("technicalRowsForAttempt: enumerates the owner-only fields", () => {
  it("carries the processor ids/codes/email so the component can gate them", () => {
    const rows = technicalRowsForAttempt(
      attempt({
        stripePaymentIntentId: "pi_1",
        stripeChargeId: "ch_1",
        receiptEmailTo: "a@example.com",
        failureCode: "card_declined",
      }),
    );
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["PaymentIntent"]).toBe("pi_1");
    expect(byLabel["Charge"]).toBe("ch_1");
    expect(byLabel["Receipt to"]).toBe("a@example.com");
    expect(byLabel["Failure code"]).toBe("card_declined");
  });
});

describe("formatCadFromCents", () => {
  it("formats or blanks", () => {
    expect(formatCadFromCents(22500)).toBe("$225.00");
    expect(formatCadFromCents(null)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR C: panels / portal / billing-adjacent payment strings are runtime-mode
// aware. STRING-ONLY changes inside billing execution files — this suite
// pins the strings AND (belt) that the old false claims are gone.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

describe("charge confirmation + failure copy is mode-aware", () => {
  it("live runtime confirmation does not say 'test charge'; test runtime still does", () => {
    const action = read("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts");
    expect(action).toMatch(/\? "Confirm the charge before running it\."/);
    expect(action).toMatch(/: "Confirm the test charge before running it\."/);
  });

  it("executor failure copy branches on the in-scope livemode (both occurrences)", () => {
    const charge = read("lib/billing/session-payment-charge.ts");
    const matches = charge.match(
      /message: livemode\s*\n?\s*\? "We could not start the charge\. Please try again\."\s*\n?\s*: "We could not start the test charge\. Please try again\."/g,
    );
    expect(matches?.length).toBe(2);
  });
});

describe("refund mode-mismatch wording", () => {
  it("no longer claims live refunds are disabled; states the row/runtime mode mismatch", () => {
    const refund = read("lib/billing/payment-refund.ts");
    expect(refund).not.toMatch(/Live refunds are not enabled/);
    expect(refund).toMatch(
      /This payment's mode does not match the current deployment mode\./,
    );
    expect(refund).toMatch(/MODE_MISMATCH_MESSAGE/);
  });
});

describe("portal live card-save wrappers", () => {
  const copy = read("lib/payments/portal-card-copy.ts");

  it("live save note: no immediate charge + later authorized studio charges", () => {
    expect(copy).toMatch(/No charge is made at the moment you add a card\./);
    expect(copy).toMatch(/the studio may charge this card for amounts you have authorized/);
    expect(copy).toMatch(/no-show fees, or late-cancellation fees/);
  });

  it("live sign note scopes the no-charge claim to the sign/save actions", () => {
    expect(copy).toMatch(/Signing itself does not charge you/);
    expect(copy).toMatch(/the studio may charge it for amounts you have authorized/);
  });

  it("the shared module is client-safe (no server-only import)", () => {
    expect(copy).not.toMatch(/import "server-only"/);
  });
});

describe("eligibility copy: no raw status enum leaks", () => {
  it("maps pending/restricted/rejected to plain language", () => {
    const src = read("lib/billing/session-payment-eligibility.ts");
    expect(src).not.toMatch(/Studio Stripe account status is "\$\{/);
    expect(src).toMatch(/Stripe is still reviewing the studio's information/);
    expect(src).toMatch(/Stripe needs more information from the studio/);
    expect(src).toMatch(/Stripe declined the studio's account/);
  });
});

describe("legal copy unchanged (proof pins)", () => {
  it("lawyer-approved portal authorization blocks are intact", () => {
    const card = read("app/portal/PortalCardOnFileCard.tsx");
    expect(card).toMatch(/By saving a payment card on file, you authorize/);
    expect(card).toMatch(/not the treatment provider or merchant of record/);
    const form = read("app/portal/PortalPaymentMethodForm.tsx");
    expect(form).toMatch(/By saving this new card, you authorize/);
  });

  it("lawyer-approved receipt template wording is intact", () => {
    // PAY-RECEIPT-PDF moved the approved copy from the email template into
    // lib/billing/receipt-document.ts, so that the PDF and the email render
    // the SAME strings rather than two hand-kept copies. The guard follows the
    // copy to its new home.
    const doc = read("lib/billing/receipt-document.ts");
    expect(doc).toMatch(/not a tax invoice/);
    expect(doc).toMatch(/not the treatment provider or merchant of record/);
  });

  it("...and survives the copy being moved again, because it checks OUTPUT", async () => {
    // The assertion above is a source grep, and a source grep silently stops
    // protecting anything the moment the text moves -- which is exactly what
    // this lane did to it. This one asserts on what a client would actually
    // read, so no future refactor can quietly defeat it.
    const { buildReceiptDocument } = await import("@/lib/billing/receipt-document");
    const live = buildReceiptDocument({
      studioName: "Willow", studioContactEmail: null, clientName: "D",
      reasonLabel: "Session payment", amountCents: 100, currencyCode: "cad",
      paidAt: new Date("2026-01-01T00:00:00Z"), livemode: true,
      settlement: { kind: "card", last4: "4242", stripePaymentIntentId: "pi", stripeChargeId: null },
    });
    expect(live.taxDisclaimer).toMatch(/not a tax invoice/);
    expect(live.platformNote).toMatch(/not the treatment provider or merchant of record/);

    // And the same words reach BOTH renderings, which is the new guarantee.
    const { buildPaymentReceiptEmail } = await import("@/lib/email/templates/payment-receipt");
    const email = buildPaymentReceiptEmail({
      studioName: "Willow", studioContactEmail: null, clientName: "D",
      chargeReasonLabel: "Session payment", amountCents: 100, currencyCode: "cad",
      chargedAt: new Date("2026-01-01T00:00:00Z"), stripePaymentIntentId: "pi",
      stripeChargeId: null, last4: "4242", livemode: true,
    });
    expect(email.text).toContain(live.taxDisclaimer);
    expect(email.text).toContain(live.platformNote!);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildPaymentReceiptEmail,
  chargeReasonLabel,
} from "@/lib/email/templates/payment-receipt";

// PR #175. The payment receipt template is the truthful content
// pinned for the receipt path. The disclaimers are the load-
// bearing piece: live mode is structurally disabled and the
// body must say so unambiguously while test mode is the only
// mode that can produce a receipt.

const FIXTURE = {
  studioName: "Willow Electrolysis",
  studioContactEmail: "studio@example.test",
  clientName: "Jamie Lin",
  chargeReasonLabel: "Session payment",
  amountCents: 12500,
  currencyCode: "cad",
  chargedAt: new Date("2026-06-08T14:32:00Z"),
  stripePaymentIntentId: "pi_test_abc123",
  stripeChargeId: "ch_test_def456" as string | null,
};

describe("buildPaymentReceiptEmail: subject", () => {
  it("starts with TEST MODE", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.subject).toMatch(/^TEST MODE/);
  });

  it("names the studio", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.subject).toMatch(/Willow Electrolysis/);
  });

  it("names the reason label", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.subject).toMatch(/Session payment/);
  });

  it("includes the amount + currency code", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.subject).toMatch(/\$125\.00 CAD/);
  });

  it("falls back to 'your studio' for an empty studio name", () => {
    const out = buildPaymentReceiptEmail({ ...FIXTURE, studioName: "   " });
    expect(out.subject).toMatch(/from your studio/);
  });
});

describe("buildPaymentReceiptEmail: body disclaimers (load-bearing)", () => {
  it("text body says 'This is a Stripe test-mode receipt. No live card was charged.'", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text).toContain(
      "This is a Stripe test-mode receipt. No live card was charged.",
    );
  });

  it("text body says 'No tax calculation is included on this receipt.'", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text).toContain(
      "No tax calculation is included on this receipt.",
    );
  });

  it("text body says refund handling is not enabled yet", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text).toMatch(/Refund handling is not enabled in Hone yet/);
  });

  it("text body does NOT use 'tax receipt'", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text.toLowerCase()).not.toContain("tax receipt");
  });

  it("text body does NOT use 'official invoice'", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text.toLowerCase()).not.toContain("official invoice");
  });

  it("text body does NOT use 'charitable receipt'", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text.toLowerCase()).not.toContain("charitable receipt");
  });

  it("text body does NOT use 'live payment completed' or similar", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text.toLowerCase()).not.toContain("live payment");
    expect(out.text.toLowerCase()).not.toContain("payment complete");
  });

  it("html body carries every disclaimer as well", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.html).toContain("This is a Stripe test-mode receipt");
    expect(out.html).toContain("No tax calculation");
    expect(out.html).toMatch(/Refund handling is not enabled/);
  });
});

describe("buildPaymentReceiptEmail: body content fields", () => {
  it("greets the client by name", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text).toContain("Hi Jamie Lin,");
  });

  it("text body includes the studio name + reason + amount + charged time", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text).toContain("Studio: Willow Electrolysis");
    expect(out.text).toContain("Reason: Session payment");
    expect(out.text).toContain("Amount: $125.00 CAD");
    expect(out.text).toContain("Charged: 2026-06-08 14:32 UTC");
  });

  it("includes the PaymentIntent id", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text).toContain("PaymentIntent: pi_test_abc123");
    expect(out.html).toContain("pi_test_abc123");
  });

  it("includes the Charge id when present", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text).toContain("Charge: ch_test_def456");
    expect(out.html).toContain("ch_test_def456");
  });

  it("omits the Charge line when stripeChargeId is null", () => {
    const out = buildPaymentReceiptEmail({ ...FIXTURE, stripeChargeId: null });
    expect(out.text).not.toMatch(/^Charge:/m);
    expect(out.html).not.toMatch(/<strong>Charge:<\/strong>/);
  });

  it("includes a studio contact line when one is provided", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.text).toMatch(
      /Questions\? Contact Willow Electrolysis at studio@example\.test/,
    );
  });

  it("omits the contact line when studioContactEmail is null", () => {
    const out = buildPaymentReceiptEmail({
      ...FIXTURE,
      studioContactEmail: null,
    });
    expect(out.text).not.toMatch(/Questions\? Contact/);
  });

  it("escapes HTML-significant characters in studio name", () => {
    const out = buildPaymentReceiptEmail({
      ...FIXTURE,
      studioName: "Willow & Co <Pilot>",
    });
    expect(out.html).not.toContain("<Pilot>");
    expect(out.html).toContain("&lt;Pilot&gt;");
  });
});

describe("chargeReasonLabel: reason-agnostic mapping", () => {
  it("maps session_payment to 'Session payment'", () => {
    expect(chargeReasonLabel("session_payment")).toBe("Session payment");
  });

  it("maps late_cancellation_fee to 'Late cancellation fee'", () => {
    expect(chargeReasonLabel("late_cancellation_fee")).toBe(
      "Late cancellation fee",
    );
  });

  it("maps no_show_fee to 'No-show fee'", () => {
    expect(chargeReasonLabel("no_show_fee")).toBe("No-show fee");
  });

  it("falls back to 'Payment' on unknown reason", () => {
    expect(chargeReasonLabel("deposit_v2")).toBe("Payment");
  });

  it("falls back to 'Payment' on null", () => {
    expect(chargeReasonLabel(null)).toBe("Payment");
  });

  it("falls back to 'Payment' on undefined", () => {
    expect(chargeReasonLabel(undefined)).toBe("Payment");
  });
});

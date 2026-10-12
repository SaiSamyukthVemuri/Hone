import { describe, expect, it } from "vitest";
import { buildReceiptDocument, type ReceiptFacts } from "@/lib/billing/receipt-document";
import { renderReceiptPdf } from "@/lib/billing/receipt-pdf";
import { buildPaymentReceiptEmail } from "@/lib/email/templates/payment-receipt";
import { extractPdfText } from "./helpers/pdf-text";

// ===========================================================================
// PAY-CCY-04 (#824) — a USD charge's receipt says USD, everywhere it is shown
// ===========================================================================
//
// Every receipt surface formats the amount from the ATTEMPT ROW's own currency
// (payment-receipt.ts passes attempt.currency), never from the studio's current
// configuration. So a USD attempt's receipt — subject, body, plain text and the
// PDF — must name USD and nothing may say CAD. The Canadian receipts stay
// byte-identical to their approved golden fixture
// (receipt-document.test.ts); the CAD control below is the same rule seen from
// this side.

const USD_CARD: ReceiptFacts = {
  studioName: "Fett Derm Studio",
  studioContactEmail: "front@fett.test",
  clientName: "Alex Rivera",
  reasonLabel: "Session payment",
  amountCents: 12500,
  currencyCode: "usd",
  paidAt: new Date("2026-10-16T18:30:00Z"),
  livemode: true,
  settlement: {
    kind: "card",
    last4: "4242",
    stripePaymentIntentId: "pi_live_us_1",
    stripeChargeId: "ch_live_us_1",
  },
};

describe("USD receipt document", () => {
  const doc = buildReceiptDocument(USD_CARD);

  it("names the amount in USD in the subject and the amount row", () => {
    expect(doc.subject).toBe("Receipt from Fett Derm Studio: Session payment $125.00 USD");
    const amountRow = doc.detailRows.find((r) => r.value.includes("$125.00"));
    expect(amountRow?.value).toBe("$125.00 USD");
  });

  it("nothing in the document says CAD", () => {
    expect(JSON.stringify(doc)).not.toMatch(/CAD/);
  });
});

describe("USD receipt email", () => {
  const email = buildPaymentReceiptEmail({
    studioName: "Fett Derm Studio",
    studioContactEmail: "front@fett.test",
    clientName: "Alex Rivera",
    chargeReasonLabel: "Session payment",
    amountCents: 12500,
    currencyCode: "usd",
    chargedAt: new Date("2026-10-16T18:30:00Z"),
    stripePaymentIntentId: "pi_live_us_1",
    stripeChargeId: "ch_live_us_1",
    last4: "4242",
    livemode: true,
  });

  it("subject, HTML and plain text all say USD and never CAD", () => {
    expect(email.subject).toContain("$125.00 USD");
    expect(email.html).toContain("$125.00 USD");
    expect(email.text).toContain("$125.00 USD");
    for (const part of [email.subject, email.html, email.text]) {
      expect(part).not.toMatch(/CAD/);
    }
  });
});

describe("USD receipt PDF", () => {
  it("the rendered PDF text says $125.00 USD and never CAD", async () => {
    const text = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(USD_CARD)));
    expect(text).toContain("$125.00 USD");
    expect(text).not.toMatch(/CAD/);
  });
});

describe("Canadian control: the same facts in CAD still say CAD", () => {
  it("document and PDF say CAD and never USD", async () => {
    const cad = { ...USD_CARD, currencyCode: "cad" };
    const doc = buildReceiptDocument(cad);
    expect(doc.subject).toBe("Receipt from Fett Derm Studio: Session payment $125.00 CAD");
    expect(JSON.stringify(doc)).not.toMatch(/USD/);
    const text = await extractPdfText(await renderReceiptPdf(doc));
    expect(text).toContain("$125.00 CAD");
  });
});

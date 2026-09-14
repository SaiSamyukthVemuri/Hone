import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPaymentReceiptEmail } from "@/lib/email/templates/payment-receipt";
import {
  buildReceiptDocument,
  UnapprovedReceiptCopyError,
  type ReceiptFacts,
} from "@/lib/billing/receipt-document";

// ===========================================================================
// PAY-RECEIPT-PDF — the canonical receipt document
// ===========================================================================
//
// The refactor that made a PDF possible moved the receipt's facts AND its
// approved wording out of the email template. The email is the surface that
// already shipped and was legally signed off, so the bar for the refactor is
// not "looks right" — it is BYTE-IDENTICAL. The golden fixture was captured
// from the pre-refactor template at the base SHA.
// ===========================================================================

type GoldenCase = { subject: string; html: string; text: string };
const GOLDEN = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests/lib/billing/__fixtures__/receipt-email-golden.json"),
    "utf8",
  ),
) as Record<string, GoldenCase>;

const CASES: Record<string, Parameters<typeof buildPaymentReceiptEmail>[0]> = {
  test_full: {
    studioName: "Willow Physio", studioContactEmail: "hello@willow.test", clientName: "Dana Reed",
    chargeReasonLabel: "Session payment", amountCents: 12500, currencyCode: "cad",
    chargedAt: new Date("2026-03-04T15:09:00Z"), stripePaymentIntentId: "pi_test_123",
    stripeChargeId: "ch_test_456", last4: "4242", livemode: false,
  },
  test_no_charge_no_contact: {
    studioName: "Willow Physio", studioContactEmail: null, clientName: "Dana Reed",
    chargeReasonLabel: "No-show fee", amountCents: 5000, currencyCode: "cad",
    chargedAt: new Date("2026-03-04T15:09:00Z"), stripePaymentIntentId: "pi_test_123",
    stripeChargeId: null, last4: null, livemode: false,
  },
  live_full: {
    studioName: "Willow Physio", studioContactEmail: "hello@willow.test", clientName: "Dana Reed",
    chargeReasonLabel: "Session payment", amountCents: 12500, currencyCode: "cad",
    chargedAt: new Date("2026-03-04T15:09:00Z"), stripePaymentIntentId: "pi_live_123",
    stripeChargeId: "ch_live_456", last4: "4242", livemode: true,
  },
  live_no_last4: {
    studioName: "Willow Physio", studioContactEmail: null, clientName: "Dana Reed",
    chargeReasonLabel: "Late cancellation fee", amountCents: 7550, currencyCode: "cad",
    chargedAt: new Date("2026-12-31T23:59:00Z"), stripePaymentIntentId: "pi_live_9",
    stripeChargeId: null, last4: null, livemode: true,
  },
  escaping: {
    studioName: "Bob & Sons <Physio>", studioContactEmail: 'a"b@x.test', clientName: "O'Neil <script>",
    chargeReasonLabel: "Session payment", amountCents: 100, currencyCode: "cad",
    chargedAt: new Date("2026-01-01T00:00:00Z"), stripePaymentIntentId: "pi_1",
    stripeChargeId: null, last4: null, livemode: true,
  },
  empty_names: {
    studioName: "  ", studioContactEmail: null, clientName: " ",
    chargeReasonLabel: " ", amountCents: 0, currencyCode: "cad",
    chargedAt: new Date("2026-01-01T00:00:00Z"), stripePaymentIntentId: "pi_1",
    stripeChargeId: null, last4: null, livemode: false,
  },
};

/** Collapse whitespace runs that sit BETWEEN tags. Nothing a client renders. */
const collapseInterTag = (html: string): string =>
  html.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();

describe("the refactor changed no rendered byte of the approved email", () => {
  it.each(Object.keys(CASES))("%s: subject and text are byte-identical", (key) => {
    const got = buildPaymentReceiptEmail(CASES[key]!);
    const want = GOLDEN[key]!;
    expect(got.subject).toBe(want.subject);
    expect(got.text).toBe(want.text);
  });

  it.each(["live_full", "live_no_last4", "escaping"])(
    "%s: the APPROVED LIVE html is byte-identical",
    (key) => {
      // The live branch is the legally signed-off surface. It is held to the
      // strictest bar: not one byte moved.
      expect(buildPaymentReceiptEmail(CASES[key]!).html).toBe(GOLDEN[key]!.html);
    },
  );

  it.each(Object.keys(CASES))("%s: html is identical once inter-tag whitespace collapses", (key) => {
    expect(collapseInterTag(buildPaymentReceiptEmail(CASES[key]!).html)).toBe(
      collapseInterTag(GOLDEN[key]!.html),
    );
  });

  it("the ONLY raw html difference anywhere is whitespace, and only in TEST-mode rows", () => {
    // Stated precisely rather than waved at. The historical template put the
    // optional Charge row on its own conditional line, so `<br/>` sits AFTER
    // the newline there and BEFORE it on every other row -- an inconsistency
    // no uniform rule reproduces. Rather than encode a cosmetic artifact into
    // the canonical data model, the difference is bounded and proven here.
    const differing: string[] = [];
    for (const key of Object.keys(CASES)) {
      const got = buildPaymentReceiptEmail(CASES[key]!).html;
      const want = GOLDEN[key]!.html;
      if (got === want) continue;
      differing.push(key);
      // Identical once every whitespace character is removed: so the only
      // edits are whitespace, never a character of content or markup.
      expect(got.replace(/\s/g, "")).toBe(want.replace(/\s/g, ""));
    }
    // Exactly the three TEST-mode cases, and no live one.
    expect(differing.sort()).toEqual(["empty_names", "test_full", "test_no_charge_no_contact"]);
  });

  it("ANTI-VACUITY: the fixture is real, and a changed fact would fail", () => {
    // Without this, an empty or self-generated fixture would pass everything.
    expect(Object.keys(GOLDEN)).toHaveLength(6);
    expect(GOLDEN.live_full!.subject).toBe(
      "Receipt from Willow Physio: Session payment $125.00 CAD",
    );
    const mutated = buildPaymentReceiptEmail({ ...CASES.live_full!, amountCents: 12501 });
    expect(mutated.subject).not.toBe(GOLDEN.live_full!.subject);
    expect(mutated.text).not.toBe(GOLDEN.live_full!.text);
  });
});

describe("the wording matches the 2026-07-04 approval record", () => {
  const live = buildReceiptDocument({
    studioName: "Willow Physio", studioContactEmail: null, clientName: "Dana",
    reasonLabel: "Session payment", amountCents: 12500, currencyCode: "cad",
    paidAt: new Date("2026-03-04T15:09:00Z"), livemode: true,
    settlement: { kind: "card", last4: "4242", stripePaymentIntentId: "pi_1", stripeChargeId: "ch_1" },
  });

  it("renders the approved live strings verbatim", () => {
    // docs/16_LIVE_PAYMENTS_READINESS.md §17.14 records that "the actual
    // strings in the code are the source of truth". These are those strings.
    expect(live.lead).toBe(
      "This receipt confirms that a card payment was processed by Willow Physio.",
    );
    expect(live.taxDisclaimer).toBe(
      "This receipt confirms payment only. It is not a tax invoice unless Willow Physio separately states that tax is included or provides a separate tax invoice.",
    );
    expect(live.supportLine).toBe(
      "For questions about this payment, refund eligibility, cancellation fees, no-show fees, or services provided, please contact Willow Physio directly.",
    );
    expect(live.platformNote).toBe(
      "Hone is the software platform used by the studio and is not the treatment provider or merchant of record.",
    );
    expect(live.subject).toBe("Receipt from Willow Physio: Session payment $125.00 CAD");
    expect(live.headline).toBe("Receipt");
  });

  it("makes no tax-invoice claim, no refund promise, no merchant-of-record claim", () => {
    const all = [live.lead, live.taxDisclaimer, live.supportLine, live.platformNote ?? ""].join(" ");
    expect(all).not.toMatch(/tax receipt|official invoice/i);
    expect(all).not.toMatch(/we will refund|guaranteed refund|refund will be/i);
    expect(all).toContain("not the treatment provider or merchant of record");
  });

  it("the live detail block carries the card last-4 and NO Stripe ids", () => {
    // The approval is explicit: live shows payment method, not PI/Charge ids.
    const labels = live.detailRows.map((r) => r.label);
    expect(labels).toEqual(["Studio", "Amount", "Reason", "Date", "Payment method"]);
    const values = live.detailRows.map((r) => r.value).join(" ");
    expect(values).toContain("Card ending in 4242");
    expect(values).not.toContain("pi_1");
    expect(values).not.toContain("ch_1");
  });

  it("a missing last-4 degrades to the neutral fallback, never blocks, never a full PAN", () => {
    const doc = buildReceiptDocument({
      studioName: "W", studioContactEmail: null, clientName: "D", reasonLabel: "Session payment",
      amountCents: 100, currencyCode: "cad", paidAt: new Date("2026-01-01T00:00:00Z"), livemode: true,
      settlement: { kind: "card", last4: null, stripePaymentIntentId: "pi", stripeChargeId: null },
    });
    expect(doc.detailRows.find((r) => r.label === "Payment method")?.value).toBe("Card on file");
  });
});

describe("settlement is a discriminant, and unapproved live copy is refused", () => {
  const externalFacts = (livemode: boolean): ReceiptFacts => ({
    studioName: "Willow Physio", studioContactEmail: null, clientName: "Dana",
    reasonLabel: "Session payment", amountCents: 12500, currencyCode: "cad",
    paidAt: new Date("2026-03-04T15:09:00Z"), livemode,
    settlement: { kind: "external", method: "paid_cash" },
  });

  it("the shape admits cash / e-transfer / other external", () => {
    const doc = buildReceiptDocument(externalFacts(false));
    expect(doc.detailRows.find((r) => r.label === "Payment method")?.value).toBe("Paid · cash");
  });

  it("REFUSES to build a LIVE external receipt — that copy has no approval", () => {
    // The 2026-07-04 sign-off is specifically about a CARD payment. Modelling
    // the shape must not create a path to unapproved client-facing wording.
    expect(() => buildReceiptDocument(externalFacts(true))).toThrow(UnapprovedReceiptCopyError);
  });

  it("reuses the repo's settlement vocabulary rather than inventing one", async () => {
    const { EXTERNALLY_COLLECTED_METHODS, SETTLEMENT_BADGE_LABEL } = await import(
      "@/lib/billing/settlement-types"
    );
    for (const method of EXTERNALLY_COLLECTED_METHODS) {
      const doc = buildReceiptDocument({ ...externalFacts(false), settlement: { kind: "external", method } });
      const value = doc.detailRows.find((r) => r.label === "Payment method")?.value;
      expect(value).toBe(SETTLEMENT_BADGE_LABEL[method]);
      // The repo rule: no label says a bare "Paid" — that word is reserved for
      // money Hone actually verified.
      expect(value).not.toBe("Paid");
    }
  });

  it("NO RUNTIME PATH constructs an external receipt yet", () => {
    // "No external-payment triggers" is a scope boundary, so it is proven, not
    // promised. The only production adapter builds a card settlement.
    const src = readFileSync(
      join(process.cwd(), "lib/email/templates/payment-receipt.ts"),
      "utf8",
    );
    expect(src).toContain('kind: "card"');
    expect(src).not.toContain('kind: "external"');
    const sender = readFileSync(join(process.cwd(), "lib/billing/payment-receipt.ts"), "utf8");
    expect(sender).not.toContain('kind: "external"');
  });
});

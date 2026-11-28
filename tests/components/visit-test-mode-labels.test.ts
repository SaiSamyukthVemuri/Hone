import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VisitMoneyBlock } from "@/components/visit-money-block";
import { visitMoneySummary } from "@/lib/billing/visit-money";
import { historyLines, TEST_EXCLUDED_NOTE, type VisitLedger } from "@/lib/billing/visit-payments-core";

// Sam, 27 Nov 2026: a Stripe TEST-mode entry is labelled ON THE ENTRY ("Test payment" for a card charge, "Test refund" for a refund) with "Excluded from statements and
// analytics."; real cash and transfers on the same visit stay unlabelled. The totals count REAL money only (Sam, 28 Nov 2026).
const bill = { id: "b", totalCents: 22500, currency: "cad" as const, referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "t" };
const mixed: VisitLedger = {
  bill,
  cards: [{ kind: "card", id: "c1", amountCents: 10000, status: "succeeded", at: "2026-11-27T10:00:00Z", platformFeeCents: null, test: true }],
  externals: [
    { kind: "external", id: "e1", method: "paid_cash", amountCents: 5000, state: "confirmed", at: "2026-11-27T10:01:00Z", note: null },
    { kind: "external", id: "e2", method: "paid_e_transfer", amountCents: 7500, state: "confirmed", at: "2026-11-27T10:02:00Z", note: null },
  ],
  refunds: [{ id: "r1", amountCents: 4000, kind: "payment_reversal", status: "succeeded", attemptId: "c1", externalPaymentId: null, reason: "", at: "2026-11-27T10:03:00Z", platformFeeReturnedCents: null, test: true }],
};
const html = (l: VisitLedger) => renderToStaticMarkup(createElement(VisitMoneyBlock, { summary: visitMoneySummary(l), currency: "cad", entries: historyLines(l) } as never));
const entries = (h: string) => [...h.matchAll(/<li data-testid="visit-money-entry" data-test-mode="(true|false)"[^>]*>(.*?)<\/li>/g)].map((m) => ({ test: m[1] === "true", text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));

describe("per-entry Stripe TEST-mode labels on the visit", () => {
  it("lists all four entries; only the card and its refund say Test, each with the excluded note", () => {
    const e = entries(html(mixed));
    expect(e).toHaveLength(4);
    const by = (s: string) => e.find((x) => x.text.startsWith(s))!;
    expect(by("Test payment").test).toBe(true);
    expect(by("Test payment").text).toContain(TEST_EXCLUDED_NOTE);
    expect(by("Test refund").test).toBe(true);
    expect(by("Test refund").text).toContain(TEST_EXCLUDED_NOTE);
    for (const real of ["Cash", "E-transfer"]) {
      expect(by(real).test).toBe(false);
      expect(by(real).text).not.toMatch(/Test|Excluded/);
    }
    expect(html(mixed).match(/Excluded from statements and analytics\./g)).toHaveLength(2);
  });
  it("the test entries stay listed and labelled but are in none of Collected / Refunded / Net (REAL money only, in every studio; was $225 / $40 / $185 before Sam's 28 Nov rule)", () => {
    const m = visitMoneySummary(mixed);
    expect([m.collectedCents, m.refundedCents, m.netCents]).toEqual([12500, 0, 12500]);
  });
  it("a live visit shows no label at all, and an entry with no mode flag is not labelled by the component", () => {
    const live: VisitLedger = { ...mixed, cards: [{ ...mixed.cards[0], test: undefined }], refunds: [{ ...mixed.refunds[0], test: undefined }] };
    const h = html(live);
    expect(h).not.toMatch(/Test payment|Test refund|Excluded/);
    expect(entries(h).every((x) => !x.test)).toBe(true);
  });
});

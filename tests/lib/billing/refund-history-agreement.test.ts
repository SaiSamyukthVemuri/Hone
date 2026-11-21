import { describe, expect, it } from "vitest";
import { refundDisplayState } from "@/lib/billing/refund-display-state";
import { outstandingForAppointment } from "@/lib/billing/outstanding-balance";

// HON-49 (migration 0358). The refund panel (refundDisplayState) and the owner's balance (outstandingForAppointment) read the refund HISTORY
// summary through two functions that must never drift: this sweeps every combination of the older refund columns and the history summary through
// BOTH and asserts that (a) the panel can state a remaining amount exactly when the balance can state a figure, and (b) the money the balance says
// the card kept equals the remaining amount the panel says is refundable. It extends refund-money-agreement.test.ts, which covers the older
// columns alone (history omitted); here the history is always supplied, including its illegal values.

const CHARGE = 5000;
const QUOTE = 10000;
const ours = [null, "pending_stripe", "succeeded", "failed", "unrecognised"] as const;
const provider = [null, "pending", "requires_action", "succeeded", "failed", "canceled", "unrecognised"] as const;
const amounts = [null, 0, 2000, CHARGE, -1] as const;
const refundIds = [null, "re_1"] as const;
const succeeded = [null, 0, 2000, CHARGE, CHARGE + 1, -1] as const;
const inflight = [undefined, null, 0, 1, -1] as const;

type O = { refundStatus: string | null; providerRefundStatus: string | null; refundAmountCents: number | null; stripeRefundId: string | null; s: number | null; f: number | null | undefined };

function views(o: O) {
  const display = refundDisplayState({
    chargeStatus: "succeeded", amountCents: CHARGE, refundStatus: o.refundStatus, refundAmountCents: o.refundAmountCents,
    providerRefundStatus: o.providerRefundStatus, stripeRefundId: o.stripeRefundId, cumulativeFullRefundVerified: false,
    refundsSucceededCents: o.s, refundsInflightCount: o.f,
  });
  const balance = outstandingForAppointment({
    status: "completed", endsAt: "2026-10-01T15:00:00Z", now: "2026-11-03T12:00:00Z", quoteCents: QUOTE, studioCurrency: "CAD", settlements: [],
    cards: [{ status: "succeeded", amountCents: CHARGE, refundStatus: o.refundStatus, refundAmountCents: o.refundAmountCents,
      providerRefundStatus: o.providerRefundStatus, currency: "cad", refundsSucceededCents: o.s, refundsInflightCount: o.f }],
  });
  return { display, balance };
}

describe("the refund panel and the owner's balance agree on every refund-history combination", () => {
  const cases: Array<[string, O]> = [];
  for (const refundStatus of ours) for (const providerRefundStatus of provider) for (const refundAmountCents of amounts)
    for (const stripeRefundId of refundIds) for (const s of succeeded) for (const f of inflight)
      cases.push([`ours=${refundStatus} provider=${providerRefundStatus} amount=${refundAmountCents} id=${stripeRefundId} S=${s} F=${f}`,
        { refundStatus, providerRefundStatus, refundAmountCents, stripeRefundId, s, f }]);

  it("covers every combination (a changed list must be deliberate)", () => {
    expect(cases.length).toBe(ours.length * provider.length * amounts.length * refundIds.length * succeeded.length * inflight.length);
    expect(cases.length).toBe(10500);
  });

  it("never lets the panel and the balance disagree about what the card kept", () => {
    const bad: string[] = [];
    for (const [label, o] of cases) {
      const { display, balance } = views(o);
      if (balance.kind === "paid" || balance.kind === "not_applicable") { bad.push(`${label}: balance ${balance.kind} (unexpected)`); continue; }
      const kept = balance.kind === "owed" ? balance.cardKeptCents : null;
      if (display.remainingRefundableCents === null) {
        if (balance.kind !== "amount_unavailable") bad.push(`${label}: panel cannot state, balance says ${balance.kind} kept=${kept}`);
      } else if (balance.kind !== "owed" || kept !== display.remainingRefundableCents) {
        bad.push(`${label}: panel remaining ${display.remainingRefundableCents}, balance ${balance.kind} kept=${kept}`);
      }
    }
    expect(bad, `${bad.length} disagreements; first: \n${bad.slice(0, 12).join("\n")}`).toEqual([]);
  });

  it("history omitted or null reads exactly as the older columns alone (every existing charge keeps its reading)", () => {
    for (const [, o] of cases) {
      if (o.s !== null || (o.f !== undefined && o.f !== null && o.f !== 0)) continue;
      const withHistory = refundDisplayState({ chargeStatus: "succeeded", amountCents: CHARGE, refundStatus: o.refundStatus, refundAmountCents: o.refundAmountCents,
        providerRefundStatus: o.providerRefundStatus, stripeRefundId: o.stripeRefundId, cumulativeFullRefundVerified: false, refundsSucceededCents: null, refundsInflightCount: o.f });
      const without = refundDisplayState({ chargeStatus: "succeeded", amountCents: CHARGE, refundStatus: o.refundStatus, refundAmountCents: o.refundAmountCents,
        providerRefundStatus: o.providerRefundStatus, stripeRefundId: o.stripeRefundId, cumulativeFullRefundVerified: false });
      expect(withHistory.kind).toBe(without.kind);
      expect(withHistory.remainingRefundableCents).toBe(without.remainingRefundableCents);
      expect(withHistory.mayStartRefund).toBe(without.mayStartRefund);
    }
  });

  it("a recorded partial refund: 2000 of 5000 back, 3000 refundable and kept, no new refund offered", () => {
    const { display, balance } = views({ refundStatus: null, providerRefundStatus: null, refundAmountCents: null, stripeRefundId: null, s: 2000, f: 0 });
    expect(display).toMatchObject({ kind: "refunded", remainingRefundableCents: 3000, refundedCents: 2000, mayStartRefund: false });
    expect(balance).toMatchObject({ kind: "owed", cardKeptCents: 3000 });
  });

  it("two partials that add up to the charge read as a full refund: 0 refundable, 0 kept", () => {
    const { display, balance } = views({ refundStatus: null, providerRefundStatus: null, refundAmountCents: null, stripeRefundId: null, s: CHARGE, f: 0 });
    expect(display).toMatchObject({ kind: "refunded", remainingRefundableCents: 0, refundedCents: CHARGE });
    expect(balance).toMatchObject({ kind: "owed", cardKeptCents: 0 });
  });

  it("a refund still in flight beside a recorded one: pending, and the balance cannot state a figure", () => {
    const { display, balance } = views({ refundStatus: null, providerRefundStatus: null, refundAmountCents: null, stripeRefundId: null, s: 2000, f: 1 });
    expect(display).toMatchObject({ kind: "pending", remainingRefundableCents: null, mayStartRefund: false });
    expect(balance.kind).toBe("amount_unavailable");
  });
});

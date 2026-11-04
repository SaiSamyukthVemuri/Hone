import { describe, expect, it } from "vitest";
import {
  outstandingForAppointment,
  outstandingFromLoad,
  type OutstandingInput,
} from "@/lib/billing/outstanding-balance";

const base: OutstandingInput = {
  status: "completed",
  endsAt: "2026-10-01T15:00:00Z",
  now: "2026-11-03T12:00:00Z",
  quoteCents: 10000,
  studioCurrency: "CAD",
  cards: [],
  settlements: [],
};
const card = (o: Partial<OutstandingInput["cards"][number]> = {}) => ({
  status: "succeeded",
  amountCents: 4000,
  refundStatus: null,
  refundAmountCents: null,
  currency: "cad",
  ...o,
});

describe("outstandingForAppointment", () => {
  it("unpaid: the whole quote, studio currency", () => {
    expect(outstandingForAppointment(base)).toMatchObject({
      kind: "owed", outstandingCents: 10000, currency: "CAD",
    });
  });
  it("partly paid by card", () => {
    expect(outstandingForAppointment({ ...base, cards: [card()] })).toMatchObject({
      kind: "owed", outstandingCents: 6000, cardKeptCents: 4000,
    });
  });
  it("partly paid by settlement", () => {
    expect(
      outstandingForAppointment({ ...base, settlements: [{ method: "paid_cash", amountCents: 2500 }] }),
    ).toMatchObject({ kind: "owed", outstandingCents: 7500, collectedCents: 2500 });
  });
  it("card plus settlement", () => {
    expect(
      outstandingForAppointment({
        ...base, cards: [card()], settlements: [{ method: "paid_e_transfer", amountCents: 3000 }],
      }),
    ).toMatchObject({ kind: "owed", outstandingCents: 3000 });
  });
  it("partial refund re-opens the refunded part; full refund owes the whole quote", () => {
    expect(
      outstandingForAppointment({
        ...base, cards: [card({ amountCents: 10000, refundStatus: "succeeded", refundAmountCents: 2500 })],
      }),
    ).toMatchObject({ kind: "owed", outstandingCents: 2500 });
    expect(
      outstandingForAppointment({
        ...base, cards: [card({ amountCents: 10000, refundStatus: "succeeded", refundAmountCents: 10000 })],
      }),
    ).toMatchObject({ kind: "owed", outstandingCents: 10000 });
  });
  // AO1 (Privacy, #1356): a refund we cannot read is NOT "no refund". It must never let the visit read as fully paid.
  it("a succeeded refund with an unreadable amount is 'amount unavailable', not paid", () => {
    for (const refundAmountCents of [null, undefined as unknown as null, -5]) {
      expect(
        outstandingForAppointment({
          ...base, cards: [card({ amountCents: 10000, refundStatus: "succeeded", refundAmountCents })],
        }),
      ).toEqual({ kind: "amount_unavailable" });
    }
  });
  it("a refund still pending or needing action (ours or the provider's) is 'amount unavailable'", () => {
    for (const c of [
      card({ refundStatus: "pending_stripe" }),
      card({ providerRefundStatus: "pending" }),
      card({ providerRefundStatus: "requires_action" }),
    ]) {
      expect(outstandingForAppointment({ ...base, cards: [c] })).toEqual({ kind: "amount_unavailable" });
    }
  });
  // V-1 (Insurance, #1356): our refund_status and the provider's stripe_refund_status are separate columns; they must agree.
  it("the provider says a refund succeeded (or anything unknown) while ours is not succeeded: 'amount unavailable'", () => {
    for (const ours of [null, "failed"]) {
      for (const provider of ["succeeded", "pending", "requires_action", "some_new_value"]) {
        expect(
          outstandingForAppointment({ ...base, cards: [card({ refundStatus: ours, providerRefundStatus: provider })] }),
          `ours ${ours} / provider ${provider}`,
        ).toEqual({ kind: "amount_unavailable" });
      }
    }
  });
  it("an unknown value of OUR refund_status is 'amount unavailable'", () => {
    expect(outstandingForAppointment({ ...base, cards: [card({ refundStatus: "weird" })] })).toEqual({ kind: "amount_unavailable" });
  });
  it("ours succeeded while the provider says failed, canceled, pending or unknown: 'amount unavailable'; provider succeeded or silent is counted", () => {
    const refunded = (providerRefundStatus: string | null) =>
      card({ amountCents: 10000, refundStatus: "succeeded", refundAmountCents: 2500, providerRefundStatus });
    for (const provider of ["failed", "canceled", "pending", "requires_action", "some_new_value"]) {
      expect(outstandingForAppointment({ ...base, cards: [refunded(provider)] }), provider).toEqual({ kind: "amount_unavailable" });
    }
    for (const provider of ["succeeded", null]) {
      expect(outstandingForAppointment({ ...base, cards: [refunded(provider)] }), String(provider)).toMatchObject({ kind: "owed", outstandingCents: 2500 });
    }
  });
  it("a refund that FAILED or was cancelled left the money in place; a readable partial refund is subtracted", () => {
    expect(outstandingForAppointment({ ...base, cards: [card({ refundStatus: "failed" })] }))
      .toMatchObject({ kind: "owed", outstandingCents: 6000 });
    expect(outstandingForAppointment({ ...base, cards: [card({ providerRefundStatus: "canceled" })] }))
      .toMatchObject({ kind: "owed", outstandingCents: 6000 });
    expect(
      outstandingForAppointment({ ...base, cards: [card({ amountCents: 10000, refundStatus: "succeeded", refundAmountCents: 2500 })] }),
    ).toMatchObject({ kind: "owed", outstandingCents: 2500 });
  });
  it("a failed or never-started charge is not money, but a charge in flight (pending) makes the amount unavailable", () => {
    for (const status of ["failed", "ready", "blocked", "cancelled"]) {
      expect(outstandingForAppointment({ ...base, cards: [card({ status })] })).toMatchObject({ kind: "owed", outstandingCents: 10000 });
    }
    expect(outstandingForAppointment({ ...base, cards: [card({ status: "pending_stripe" })] })).toEqual({ kind: "amount_unavailable" });
  });
  // AO2 / U2: every other money form the caller found makes the amount unavailable, never a guess.
  it("any money form this function does not subtract makes the amount unavailable", () => {
    for (const form of ["fee_charge", "booking_charge", "appointment_refund", "dispute", "deleted_session_charge", "session_price_recorded"]) {
      expect(outstandingForAppointment({ ...base, unprovenMoney: [form] })).toEqual({ kind: "amount_unavailable" });
    }
    expect(outstandingForAppointment({ ...base, unprovenMoney: [] })).toMatchObject({ kind: "owed" });
    // A waived visit is owner-attested as owing nothing, whatever else is recorded.
    expect(outstandingForAppointment({ ...base, unprovenMoney: ["dispute"], settlements: [{ method: "waived", amountCents: 0 }] })).toEqual({ kind: "paid" });
  });
  it("waived owes nothing; still_owes changes no amount", () => {
    expect(outstandingForAppointment({ ...base, settlements: [{ method: "waived", amountCents: 0 }] }))
      .toEqual({ kind: "paid" });
    expect(outstandingForAppointment({ ...base, settlements: [{ method: "still_owes", amountCents: 0 }] }))
      .toMatchObject({ kind: "owed", outstandingCents: 10000 });
  });
  it("paid in full (or overpaid) disappears", () => {
    expect(outstandingForAppointment({ ...base, cards: [card({ amountCents: 10000 })] })).toEqual({ kind: "paid" });
    expect(
      outstandingForAppointment({ ...base, settlements: [{ method: "paid_cash", amountCents: 12000 }] }),
    ).toEqual({ kind: "paid" });
  });
  it("unknown quote is 'amount unavailable', never 0", () => {
    expect(outstandingForAppointment({ ...base, quoteCents: null })).toEqual({ kind: "amount_unavailable" });
  });
  it("unknown currency shows no amount", () => {
    expect(outstandingForAppointment({ ...base, studioCurrency: null })).toEqual({ kind: "amount_unavailable" });
  });
  // U3 (Insurance, #1356): money in two currencies, or in a currency other than the studio's, is never summed.
  it("card money in a currency other than the studio's is 'amount unavailable'", () => {
    expect(outstandingForAppointment({ ...base, studioCurrency: "CAD", cards: [card({ currency: "usd" })] })).toEqual({ kind: "amount_unavailable" });
  });
  it("two card currencies, a succeeded card with no currency, or a settlement in another currency are 'amount unavailable'", () => {
    expect(outstandingForAppointment({ ...base, cards: [card({ currency: "cad" }), card({ currency: "usd" })] })).toEqual({ kind: "amount_unavailable" });
    expect(outstandingForAppointment({ ...base, cards: [card({ currency: null })] })).toEqual({ kind: "amount_unavailable" });
    expect(
      outstandingForAppointment({ ...base, settlements: [{ method: "paid_cash", amountCents: 1000, currency: "usd" }] }),
    ).toEqual({ kind: "amount_unavailable" });
  });
  it("matching currencies (any case) sum normally, and an unknown studio currency takes the single card currency", () => {
    expect(outstandingForAppointment({ ...base, studioCurrency: "cad", cards: [card({ currency: "CAD" })], settlements: [{ method: "paid_cash", amountCents: 1000, currency: "cad" }] }))
      .toMatchObject({ kind: "owed", outstandingCents: 5000, currency: "CAD" });
    expect(outstandingForAppointment({ ...base, studioCurrency: null, cards: [card({ currency: "usd" })] })).toMatchObject({ kind: "owed", currency: "USD" });
  });
  it("cancelled, no-show, future and $0 appointments are excluded", () => {
    for (const status of ["cancelled", "no_show", "scheduled", null]) {
      expect(outstandingForAppointment({ ...base, status })).toEqual({ kind: "not_applicable" });
    }
    expect(outstandingForAppointment({ ...base, endsAt: "2026-11-04T10:00:00Z" })).toEqual({ kind: "not_applicable" });
    expect(outstandingForAppointment({ ...base, quoteCents: 0 })).toEqual({ kind: "not_applicable" });
    expect(outstandingForAppointment({ ...base, endsAt: "not a date" })).toEqual({ kind: "not_applicable" });
  });
  it("a read failure is 'unavailable', never an empty or paid result", () => {
    expect(outstandingFromLoad({ ok: false })).toEqual({ kind: "unavailable" });
    expect(outstandingFromLoad({ ok: true, input: base })).toMatchObject({ kind: "owed" });
  });
});

describe("quoteIsCurrentPrice (OPS ruling, #1356)", () => {
  const base = { status: "completed", endsAt: "2026-11-01T15:00:00Z", now: "2026-11-04T12:00:00Z", studioCurrency: "cad", settlements: [] };
  const card = { status: "succeeded", amountCents: 10000, refundStatus: null, refundAmountCents: null, providerRefundStatus: null, currency: "cad" };
  it("a succeeded card charge short of today's price is unavailable, not a balance", () => {
    expect(outstandingForAppointment({ ...base, quoteCents: 12000, cards: [card], quoteIsCurrentPrice: true } as never)).toEqual({ kind: "amount_unavailable" });
  });
  it("the same inputs with a RECORDED quote still give the remainder", () => {
    expect(outstandingForAppointment({ ...base, quoteCents: 12000, cards: [card], quoteIsCurrentPrice: false } as never)).toMatchObject({ kind: "owed", outstandingCents: 2000 });
  });
  it("nothing paid keeps today's quote; paid up is paid", () => {
    expect(outstandingForAppointment({ ...base, quoteCents: 12000, cards: [], quoteIsCurrentPrice: true } as never)).toMatchObject({ kind: "owed", outstandingCents: 12000 });
    expect(outstandingForAppointment({ ...base, quoteCents: 10000, cards: [card], quoteIsCurrentPrice: true } as never)).toEqual({ kind: "paid" });
  });
  it("a collected settlement amount against today's price is treated like a card charge", () => {
    const cash = { method: "paid_cash", amountCents: 10000, currency: "cad" };
    expect(outstandingForAppointment({ ...base, quoteCents: 12000, cards: [], settlements: [cash], quoteIsCurrentPrice: true } as never)).toEqual({ kind: "amount_unavailable" });
    expect(outstandingForAppointment({ ...base, quoteCents: 12000, cards: [], settlements: [cash], quoteIsCurrentPrice: false } as never)).toMatchObject({ kind: "owed", outstandingCents: 2000 });
    expect(outstandingForAppointment({ ...base, quoteCents: 10000, cards: [], settlements: [cash], quoteIsCurrentPrice: true } as never)).toEqual({ kind: "paid" });
  });
});

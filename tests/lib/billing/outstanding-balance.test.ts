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
  it("an unreadable refund amount is NOT assumed full", () => {
    expect(
      outstandingForAppointment({
        ...base, cards: [card({ amountCents: 10000, refundStatus: "succeeded", refundAmountCents: null })],
      }),
    ).toEqual({ kind: "paid" });
  });
  it("a pending or failed charge is not money", () => {
    expect(outstandingForAppointment({ ...base, cards: [card({ status: "pending_stripe" })] }))
      .toMatchObject({ kind: "owed", outstandingCents: 10000 });
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
  it("the charge's own currency wins over the studio's", () => {
    expect(
      outstandingForAppointment({ ...base, studioCurrency: "CAD", cards: [card({ currency: "usd" })] }),
    ).toMatchObject({ currency: "USD" });
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

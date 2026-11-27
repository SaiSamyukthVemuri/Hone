import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readMoneyForAppointments } from "@/lib/finance/statement-money-read";

// v1 refund truth, statement side: the same money as payment_refund_money (0393). Synthetic ids only.
const STUDIO = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const ATT = "33333333-3333-4333-8333-333333333333";

function fake(tables: Record<string, unknown[]>, failing: string | null = null) {
  return { from(t: string) {
    const q: Record<string, unknown> = {};
    const self = () => q;
    Object.assign(q, { select: self, eq: self, is: self, not: self, in: self, order: self, range: self, limit: self,
      then: (res: (v: unknown) => unknown) => res({ data: failing === t ? null : tables[t] ?? [], error: failing === t ? { code: "x" } : null }) });
    return q;
  } } as never;
}
const card = (extra: Record<string, unknown>) => ({ id: ATT, charge_reason: "session_payment", status: "succeeded", amount_cents: 10000, currency: "cad", refund_status: null, refund_amount_cents: null,
  stripe_refund_status: null, stripe_refund_id: null, stripe_charge_refund_event_id: null, stripe_livemode: false, appointment_id: A, session_id: null, ...extra });
const tables = (cardExtra: Record<string, unknown>, refunds: unknown[], reviews: unknown[] = []) => ({
  sessions: [], visit_bills: [{ appointment_id: A, total_cents: 10000, currency: "cad" }], visit_external_payments: [],
  payment_refunds: refunds, payment_refund_reviews: reviews, payment_charge_attempts: [card(cardExtra)], appointment_settlements: [], manual_fee_charge_attempts: [],
});
const moneyOf = (r: Awaited<ReturnType<typeof readMoneyForAppointments>>) => (r.ok ? r.settlementRows.filter((s) => s.method === "partial_refund" || s.method === "refund_in_flight").map((s) => [s.method, s.amountCents]) : null);

describe("the statement read of a billed card payment refunded in two places", () => {
  it("$40 here, then the owner refunds the rest in the dashboard (attempt succeeded/100): a second line for the $60, so returned is $100 not $40", async () => {
    const r = await readMoneyForAppointments(fake(tables({ refund_status: "succeeded", refund_amount_cents: 10000 }, [{ appointment_id: A, attempt_id: ATT, amount_cents: 4000, currency: "cad", status: "succeeded", legacy: false }])), STUDIO, [A]);
    expect(moneyOf(r)).toEqual([["partial_refund", 4000], ["partial_refund", 6000]]);
    expect(r.ok && r.cardRows[0]).toMatchObject({ refundStatus: null, refundAmountCents: null }); // the card's own full-refund line is not shown a second time
  });
  it("no dashboard refund: only the split row (nothing added)", async () => {
    const r = await readMoneyForAppointments(fake(tables({}, [{ appointment_id: A, attempt_id: ATT, amount_cents: 4000, currency: "cad", status: "succeeded", legacy: false }])), STUDIO, [A]);
    expect(moneyOf(r)).toEqual([["partial_refund", 4000]]);
  });
  it("an open review is a refund in flight: the visit's figure is unresolved, never paid", async () => {
    const r = await readMoneyForAppointments(fake(tables({}, [], [{ appointment_id: A, amount_cents: 3000, currency: "cad" }])), STUDIO, [A]);
    expect(moneyOf(r)).toEqual([["refund_in_flight", 3000]]);
  });
  it("a failed read of the reviews fails the whole read", async () => {
    expect((await readMoneyForAppointments(fake(tables({}, []), "payment_refund_reviews"), STUDIO, [A])).ok).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readMoneyForAppointments } from "@/lib/finance/statement-money-read";

// Codex follow-up on #1827: the statement reads card payments BY APPOINTMENT as well as by chart, so a soft-deleted chart never drops a live card or its refund (Collected, Refunded and Net stay right).
// The fake HONOURS .eq() and .in() like PostgREST, so a read keyed on live sessions really does miss a payment whose chart is gone.
const STUDIO = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const ATT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";

function fake(tables: Record<string, Array<Record<string, unknown>>>) {
  return { from(t: string) {
    const eqs: Array<[string, unknown]> = []; const ins: Array<[string, readonly unknown[]]> = [];
    const q: Record<string, unknown> = {};
    const self = () => q;
    Object.assign(q, { select: self, is: self, not: self, order: self, range: self, limit: self,
      eq: (c: string, v: unknown) => { eqs.push([c, v]); return q; }, in: (c: string, vs: readonly unknown[]) => { ins.push([c, vs]); return q; },
      then: (res: (v: unknown) => unknown) => res({ data: (tables[t] ?? []).filter((r) => eqs.every(([c, v]) => !(c in r) || r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]))), error: null }) });
    return q;
  } } as never;
}
const card = { id: ATT, charge_reason: "session_payment", status: "succeeded", amount_cents: 10000, currency: "cad", refund_status: null, refund_amount_cents: null, stripe_refund_status: null,
  stripe_refund_id: null, stripe_charge_refund_event_id: null, stripe_livemode: true, appointment_id: A, session_id: SESSION, studio_id: STUDIO };
const tables = (liveChart: boolean) => ({
  sessions: liveChart ? [{ id: SESSION, appointment_id: A, studio_id: STUDIO }] : [],   // soft-deleted: the live-session read no longer returns it
  visit_bills: [{ appointment_id: A, total_cents: 10000, currency: "cad", studio_id: STUDIO }], visit_external_payments: [],
  payment_refunds: [{ appointment_id: A, attempt_id: ATT, amount_cents: 4000, currency: "cad", status: "succeeded", legacy: false, kind: "payment_reversal", studio_id: STUDIO }],
  payment_refund_reviews: [], payment_charge_attempts: [card], appointment_settlements: [], manual_fee_charge_attempts: [],
});

describe("a live card whose chart was soft-deleted stays in the statement", () => {
  it("the card line and its $40 refund are still read (Collected $100, Refunded $40)", async () => {
    const r = await readMoneyForAppointments(fake(tables(false)), STUDIO, [A]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cardRows.map((c) => [c.status, c.amountCents])).toEqual([["succeeded", 10000]]);
    expect(r.settlementRows.filter((s) => s.method === "partial_refund").map((s) => s.amountCents)).toEqual([4000]);
  });
  it("the result is byte-identical whether the chart is live or soft-deleted (a visit without a deleted chart is unchanged)", async () => {
    const live = await readMoneyForAppointments(fake(tables(true)), STUDIO, [A]);
    const deleted = await readMoneyForAppointments(fake(tables(false)), STUDIO, [A]);
    expect(JSON.stringify(deleted)).toBe(JSON.stringify(live));
  });
});

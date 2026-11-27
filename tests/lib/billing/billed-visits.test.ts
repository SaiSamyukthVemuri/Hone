import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { billedPaymentState, readBilledVisits } from "@/lib/billing/billed-visits";

// HON-123 (Codex P1): a billed visit whose card payment was refunded through the attempt itself (the older refund control, or Stripe's dashboard via the webhook) carries a
// LEGACY mirror row. The roster read must count it for an attempt that is on the bill, as visit_payment_position does, or the refunded visit still reads "paid". Synthetic ids only.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const ATT = "33333333-3333-4333-8333-333333333333";
const OTHER_ATT = "44444444-4444-4444-8444-444444444444";

function fake(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const self = () => q;
      Object.assign(q, { select: self, eq: self, is: self, not: self, in: self, order: self, range: self, limit: self,
        then: (res: (v: unknown) => unknown) => res({ data: tables[table] ?? [], error: null }) });
      return q;
    },
  } as never;
}
const base = {
  visit_bills: [{ appointment_id: A, total_cents: 10000, currency: "cad" }],
  visit_external_payments: [],
  payment_charge_attempts: [{ id: ATT, appointment_id: A }],
};
const card = [{ status: "succeeded", amount_cents: 10000, currency: "cad" }];

describe("a billed visit's roster read counts a legacy full-refund mirror of a billed card payment", () => {
  it("$100 billed, the card fully refunded through the attempt: still paid, nothing is owed (product rule: a refund never reopens a balance)", async () => {
    const r = await readBilledVisits(fake({ ...base, payment_refunds: [{ appointment_id: A, attempt_id: ATT, amount_cents: 10000, status: "succeeded", legacy: true }] }), STUDIO, [A]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.billed.get(A)?.refunds).toEqual([{ amountCents: 10000, status: "succeeded" }]);
      expect(billedPaymentState(r.billed.get(A)!, card)).toBe("paid");
    }
  });
  it("control: the same visit with no refund is paid", async () => {
    const r = await readBilledVisits(fake({ ...base, payment_refunds: [] }), STUDIO, [A]);
    expect(r.ok && billedPaymentState(r.billed.get(A)!, card)).toBe("paid");
  });
  it("a legacy mirror of an attempt that is NOT on the bill is not this visit's refund", async () => {
    const r = await readBilledVisits(fake({ ...base, payment_refunds: [{ appointment_id: A, attempt_id: OTHER_ATT, amount_cents: 10000, status: "succeeded", legacy: true }] }), STUDIO, [A]);
    expect(r.ok && r.billed.get(A)?.refunds).toEqual([]);
  });
  it("a split refund still counts as before", async () => {
    const r = await readBilledVisits(fake({ ...base, payment_refunds: [{ appointment_id: A, attempt_id: ATT, amount_cents: 4000, status: "succeeded", legacy: false }] }), STUDIO, [A]);
    expect(r.ok && r.billed.get(A)?.refunds).toEqual([{ amountCents: 4000, status: "succeeded" }]);
  });
});

// v1 refund truth: the same money as payment_refund_money (0393), read in bulk. The attempt's own columns are Stripe's cumulative statement of the whole payment.
describe("a billed visit's roster read: the dashboard refund of the rest, and an unconfirmed review", () => {
  const withAttempt = (extra: Record<string, unknown>) => ({ ...base, payment_charge_attempts: [{ id: ATT, appointment_id: A, status: "succeeded", amount_cents: 10000, refund_status: null, refund_amount_cents: null, ...extra }] });
  it("$40 refunded here, then the owner refunds the rest in the dashboard (attempt succeeded/100): returned is $100 (the greater, never the sum), the visit is still paid (a refund never reopens a balance)", async () => {
    const r = await readBilledVisits(fake({ ...withAttempt({ refund_status: "succeeded", refund_amount_cents: 10000 }), payment_refunds: [{ appointment_id: A, attempt_id: ATT, amount_cents: 4000, status: "succeeded", legacy: false }] }), STUDIO, [A]);
    expect(r.ok && r.billed.get(A)?.refunds).toEqual([{ amountCents: 4000, status: "succeeded" }, { amountCents: 6000, status: "succeeded" }]);
    expect(r.ok && billedPaymentState(r.billed.get(A)!, card)).toBe("paid");
  });
  it("a whole-payment refund already in the rows is not counted twice", async () => {
    const r = await readBilledVisits(fake({ ...withAttempt({ refund_status: "succeeded", refund_amount_cents: 10000 }), payment_refunds: [{ appointment_id: A, attempt_id: ATT, amount_cents: 10000, status: "succeeded", legacy: true }] }), STUDIO, [A]);
    expect(r.ok && r.billed.get(A)?.refunds).toEqual([{ amountCents: 10000, status: "succeeded" }]);
  });
  it("an open review reads as a refund in flight: the figure is unavailable, never paid", async () => {
    const r = await readBilledVisits(fake({ ...withAttempt({}), payment_refunds: [], payment_refund_reviews: [{ appointment_id: A, amount_cents: 3000 }] }), STUDIO, [A]);
    expect(r.ok && r.billed.get(A)?.refunds).toEqual([{ amountCents: 3000, status: "pending_stripe" }]);
    expect(r.ok && billedPaymentState(r.billed.get(A)!, card)).toBe("unavailable");
  });
  it("a failed read of the reviews fails the whole read (unknown is not 'no review')", async () => {
    const failing = { from: (t: string) => { const q: Record<string, unknown> = {}; const self = () => q; Object.assign(q, { select: self, eq: self, is: self, not: self, in: self, order: self, range: self, limit: self, then: (res: (v: unknown) => unknown) => res({ data: t === "payment_refund_reviews" ? null : (({ ...base, payment_refunds: [] }) as Record<string, unknown[]>)[t] ?? [], error: t === "payment_refund_reviews" ? { code: "x" } : null }) }); return q; } } as never;
    expect((await readBilledVisits(failing, STUDIO, [A])).ok).toBe(false);
  });
});

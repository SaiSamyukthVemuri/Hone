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
  it("$100 billed, the card fully refunded through the attempt: NOT paid (Checkout stays open)", async () => {
    const r = await readBilledVisits(fake({ ...base, payment_refunds: [{ appointment_id: A, attempt_id: ATT, amount_cents: 10000, status: "succeeded", legacy: true }] }), STUDIO, [A]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.billed.get(A)?.refunds).toEqual([{ amountCents: 10000, status: "succeeded" }]);
      expect(billedPaymentState(r.billed.get(A)!, card)).toBe("chargeable");
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

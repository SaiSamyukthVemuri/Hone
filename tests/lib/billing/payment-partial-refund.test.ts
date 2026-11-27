import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const S = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({ getSessionPaymentStripe: () => ({ refunds: { create: S.create, list: S.list } }) }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "att-1", studio_id: "st-1", client_id: "c-1", status: "succeeded", stripe_charge_id: "ch_1", stripe_account_id: null, stripe_livemode: false, charge_reason: "session_payment" } }) }) }) }) }),
    rpc: (name: string, args: unknown) => { S.finish(name, args); return Promise.resolve({ data: [{ result: "x" }], error: null }); },
  }),
}));

import { refundCardPaymentPartial, type PendingRefundRow } from "@/lib/billing/payment-partial-refund";

// HON-122 P3(a): Stripe forgets an idempotency key after 24 hours. A retry of an unknown refund row after about 23 hours looks up the refund the row
// already made (by the metadata every create carries) BEFORE it may create, so a late retry can never refund twice. Synthetic ids only.

const now = Date.now();
const row = (ageMs: number): PendingRefundRow => ({ id: "rf-1", studioId: "st-1", attemptId: "att-1", amountCents: 4000, status: "pending_stripe", source: "hone", requestedAt: new Date(now - ageMs).toISOString() });
const made = { id: "re_1", status: "succeeded", metadata: { hone_payment_refund_id: "rf-1" } };

beforeEach(() => { S.create.mockReset(); S.list.mockReset(); S.finish.mockReset(); });

describe("refundCardPaymentPartial on a retry", () => {
  it("a first call finds nothing at Stripe, then creates once with the row id as the idempotency key", async () => {
    S.list.mockResolvedValue({ data: [] });
    S.create.mockResolvedValue({ ...made });
    const out = await refundCardPaymentPartial({ row: row(60_000), feeReturnedCents: null });
    expect(S.list).toHaveBeenCalledTimes(1);
    expect(S.create).toHaveBeenCalledTimes(1);
    expect(S.create.mock.calls[0][1].idempotencyKey).toBe("hone:payment_refund:rf-1");
    expect(out.outcome).toBe("succeeded");
  });

  it("a RECENT recheck of a pending refund reads the live refund (not create's replayed pending) and settles the row", async () => {
    // create's saved response is "pending" for 24 hours; the list read shows what Stripe has now.
    S.create.mockResolvedValue({ ...made, status: "pending" });
    S.list.mockResolvedValueOnce({ data: [] });
    expect((await refundCardPaymentPartial({ row: row(60_000), feeReturnedCents: null })).outcome).toBe("unknown");
    expect(S.finish).not.toHaveBeenCalled();
    S.create.mockClear();
    S.list.mockResolvedValueOnce({ data: [{ ...made, status: "succeeded" }] });
    const out = await refundCardPaymentPartial({ row: row(120_000), feeReturnedCents: null });
    expect(S.create).not.toHaveBeenCalled();
    expect(S.finish.mock.calls[0][1]).toMatchObject({ p_refund_id: "rf-1", p_outcome: "succeeded", p_stripe_refund_id: "re_1" });
    expect(out.outcome).toBe("succeeded");
  });

  it("an old row whose refund already exists at Stripe is settled from it: ZERO creates", async () => {
    S.list.mockResolvedValue({ data: [{ id: "re_other", status: "succeeded", metadata: { hone_payment_refund_id: "rf-9" } }, made] });
    const out = await refundCardPaymentPartial({ row: row(24 * 3600 * 1000), feeReturnedCents: null });
    expect(S.create).not.toHaveBeenCalled();
    expect(S.finish).toHaveBeenCalledTimes(1);
    expect(S.finish.mock.calls[0][1]).toMatchObject({ p_refund_id: "rf-1", p_outcome: "succeeded", p_stripe_refund_id: "re_1" });
    expect(out.outcome).toBe("succeeded");
  });

  it("an old row with no refund at Stripe creates exactly one", async () => {
    S.list.mockResolvedValue({ data: [{ id: "re_other", status: "succeeded", metadata: { hone_payment_refund_id: "rf-9" } }] });
    S.create.mockResolvedValue({ ...made });
    await refundCardPaymentPartial({ row: row(30 * 3600 * 1000), feeReturnedCents: null });
    expect(S.create).toHaveBeenCalledTimes(1);
  });

  it("an old row when Stripe cannot be asked is UNKNOWN, never a blind create", async () => {
    S.list.mockRejectedValue(new Error("connection reset"));
    const out = await refundCardPaymentPartial({ row: row(30 * 3600 * 1000), feeReturnedCents: null });
    expect(S.create).not.toHaveBeenCalled();
    expect(S.finish).not.toHaveBeenCalled();
    expect(out.outcome).toBe("unknown");
  });
});

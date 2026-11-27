import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const S = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  retrieve: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({ getSessionPaymentStripe: () => ({ refunds: { create: S.create, list: S.list, retrieve: S.retrieve } }) }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "att-1", studio_id: "st-1", client_id: "c-1", status: "succeeded", stripe_charge_id: "ch_1", stripe_account_id: null, stripe_livemode: false, charge_reason: "session_payment" } }) }) }) }) }),
    rpc: (name: string, args: unknown) => { S.finish(name, args); return Promise.resolve({ data: [{ result: "x" }], error: null }); },
  }),
}));

import Stripe from "stripe";
import { refundCardPaymentPartial, isDefinitiveRefundRefusal, DEFINITIVE_REFUND_REFUSAL_CODES, type PendingRefundRow } from "@/lib/billing/payment-partial-refund";

// HON-122 refund state machine (r4). Synthetic ids only.
//   stored id => retrieve (never create); no id + recent => create (key = row id) then record_refund_sent; no id + older than the idempotency window =>
//   list by metadata BEFORE create; terminal fail only for the explicit code allowlist, after ONE list; every other error is unknown.

const now = Date.now();
const row = (ageMs: number, stripeRefundId: string | null = null): PendingRefundRow => ({ id: "rf-1", studioId: "st-1", attemptId: "att-1", amountCents: 4000, status: "pending_stripe", source: "hone", requestedAt: new Date(now - ageMs).toISOString(), stripeRefundId });
const made = { id: "re_1", status: "succeeded", charge: "ch_1", metadata: { hone_payment_refund_id: "rf-1" } };
const stripeErr = (code: string, type: "invalid_request_error" | "card_error" = "invalid_request_error", status = 400) =>
  Stripe.errors.StripeError.generate({ type, code, message: "synthetic", statusCode: status } as never);
const finishCalls = () => S.finish.mock.calls.filter((c) => c[0] === "finish_payment_refund").map((c) => c[1]);
const sentCalls = () => S.finish.mock.calls.filter((c) => c[0] === "record_refund_sent").map((c) => c[1]);

beforeEach(() => { S.create.mockReset(); S.list.mockReset(); S.finish.mockReset(); S.retrieve.mockReset(); });

describe("refundCardPaymentPartial", () => {
  it("a first call creates ONCE with the row id as key and no list call, stores the Stripe id, then settles", async () => {
    S.create.mockResolvedValue({ ...made });
    const out = await refundCardPaymentPartial({ row: row(60_000), feeReturnedCents: null });
    expect(S.list).not.toHaveBeenCalled();
    expect(S.create).toHaveBeenCalledTimes(1);
    expect(S.create.mock.calls[0][1].idempotencyKey).toBe("hone:payment_refund:rf-1");
    expect(sentCalls()).toEqual([{ p_refund_id: "rf-1", p_stripe_refund_id: "re_1" }]);
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "succeeded", p_stripe_refund_id: "re_1" });
    expect(out.outcome).toBe("succeeded");
  });

  it("a row with a STORED id retrieves it and never creates; a pending refund stays unknown, then settles when Stripe says succeeded", async () => {
    S.retrieve.mockResolvedValueOnce({ ...made, status: "pending" });
    expect((await refundCardPaymentPartial({ row: row(60_000, "re_1"), feeReturnedCents: null })).outcome).toBe("unknown");
    expect(finishCalls()).toHaveLength(0);
    S.retrieve.mockResolvedValueOnce({ ...made, status: "succeeded" });
    expect((await refundCardPaymentPartial({ row: row(120_000, "re_1"), feeReturnedCents: null })).outcome).toBe("succeeded");
    expect(S.create).not.toHaveBeenCalled();
    expect(S.list).not.toHaveBeenCalled();
  });

  it("a stored id that Stripe says failed or canceled settles the row failed; one on ANOTHER charge is not trusted", async () => {
    S.retrieve.mockResolvedValueOnce({ ...made, status: "canceled" });
    expect((await refundCardPaymentPartial({ row: row(1000, "re_1"), feeReturnedCents: null })).outcome).toBe("failed");
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "failed", p_stripe_refund_id: "re_1" });
    S.finish.mockClear();
    S.retrieve.mockResolvedValueOnce({ ...made, charge: "ch_other" });
    expect((await refundCardPaymentPartial({ row: row(1000, "re_1"), feeReturnedCents: null })).outcome).toBe("unknown");
    expect(finishCalls()).toHaveLength(0);
  });

  it("a retrieve error is unknown, never failed and never a create", async () => {
    S.retrieve.mockRejectedValue(new Error("connection reset"));
    expect((await refundCardPaymentPartial({ row: row(1000, "re_1"), feeReturnedCents: null })).outcome).toBe("unknown");
    expect(S.create).not.toHaveBeenCalled();
    expect(finishCalls()).toHaveLength(0);
  });

  it("an old row (past the idempotency window) whose refund exists at Stripe is settled from the list: ZERO creates", async () => {
    S.list.mockResolvedValue({ data: [{ id: "re_other", status: "succeeded", metadata: { hone_payment_refund_id: "rf-9" } }, made], has_more: false });
    const out = await refundCardPaymentPartial({ row: row(24 * 3600 * 1000), feeReturnedCents: null });
    expect(S.create).not.toHaveBeenCalled();
    expect(finishCalls()[0]).toMatchObject({ p_refund_id: "rf-1", p_outcome: "succeeded", p_stripe_refund_id: "re_1" });
    expect(out.outcome).toBe("succeeded");
  });

  it("an old row with nothing at Stripe creates exactly one; a list that errors or has_more is unknown, never a blind create", async () => {
    S.list.mockResolvedValue({ data: [], has_more: false });
    S.create.mockResolvedValue({ ...made });
    await refundCardPaymentPartial({ row: row(30 * 3600 * 1000), feeReturnedCents: null });
    expect(S.create).toHaveBeenCalledTimes(1);
    S.create.mockClear();
    S.list.mockRejectedValue(new Error("connection reset"));
    expect((await refundCardPaymentPartial({ row: row(30 * 3600 * 1000), feeReturnedCents: null })).outcome).toBe("unknown");
    S.list.mockResolvedValue({ data: [], has_more: true });
    expect((await refundCardPaymentPartial({ row: row(30 * 3600 * 1000), feeReturnedCents: null })).outcome).toBe("unknown");
    expect(S.create).not.toHaveBeenCalled();
  });

  it("the allowlist is exactly the four documented codes", () => {
    expect([...DEFINITIVE_REFUND_REFUSAL_CODES].sort()).toEqual(["amount_too_large", "charge_already_refunded", "charge_disputed", "refund_disputed_payment"]);
  });

  it.each([...DEFINITIVE_REFUND_REFUSAL_CODES])("%s after ONE list that finds nothing records a terminal fail", async (code) => {
    S.create.mockRejectedValue(stripeErr(code));
    S.list.mockResolvedValue({ data: [], has_more: false });
    const out = await refundCardPaymentPartial({ row: row(1000), feeReturnedCents: null });
    expect(S.list).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe("failed");
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "failed", p_failure_code: code });
  });

  it("charge_already_refunded when the list FINDS this row's refund settles from it (not failed); a list error leaves the row pending", async () => {
    S.create.mockRejectedValue(stripeErr("charge_already_refunded"));
    S.list.mockResolvedValueOnce({ data: [made], has_more: false });
    expect((await refundCardPaymentPartial({ row: row(1000), feeReturnedCents: null })).outcome).toBe("succeeded");
    S.finish.mockClear();
    S.list.mockRejectedValueOnce(new Error("boom"));
    expect((await refundCardPaymentPartial({ row: row(1000), feeReturnedCents: null })).outcome).toBe("unknown");
    expect(finishCalls()).toHaveLength(0);
  });

  it.each([
    ["409 idempotency error", Stripe.errors.StripeError.generate({ type: "idempotency_error", message: "x", statusCode: 409 } as never)],
    ["429 rate limit", stripeErr("rate_limit", "invalid_request_error", 429)],
    ["5xx api error", Stripe.errors.StripeError.generate({ type: "api_error", message: "x", statusCode: 500 } as never)],
    ["an unknown 4xx code", stripeErr("something_new")],
    ["a card error", stripeErr("card_declined", "card_error", 402)],
    ["a connection error", new Stripe.errors.StripeConnectionError({ message: "reset", type: "api_error" } as never)],
    ["a plain error", new Error("boom")],
  ])("%s is NOT definitive: the row stays pending, no terminal fail, no lookup", async (_n, err) => {
    expect(isDefinitiveRefundRefusal(err)).toBe(false);
    S.create.mockRejectedValue(err);
    const out = await refundCardPaymentPartial({ row: row(1000), feeReturnedCents: null });
    expect(out.outcome).toBe("unknown");
    expect(finishCalls()).toHaveLength(0);
    expect(S.list).not.toHaveBeenCalled();
  });
});

// Privacy (finish_payment_refund stores the caller's failure fields): only the fixed sentence and a code-shaped value ever reach it, never a Stripe message.
describe("what is passed to finish_payment_refund as the failure fields", () => {
  const HOSTILE = "Card ending 4242 for alice@example.com was refused, call +1 555 010 0000";
  it("a definitive Stripe refusal stores the fixed sentence, not the Stripe message", async () => {
    S.list.mockResolvedValue({ data: [], has_more: false });
    S.create.mockRejectedValue(Stripe.errors.StripeError.generate({ type: "invalid_request_error", code: "charge_already_refunded", message: HOSTILE, statusCode: 400 } as never));
    await refundCardPaymentPartial({ row: row(60_000), feeReturnedCents: null });
    const f = finishCalls().filter((a) => (a as { p_outcome: string }).p_outcome === "failed") as Array<Record<string, unknown>>;
    expect(f).toHaveLength(1);
    expect(f[0].p_failure_message_safe).toBe("Stripe refused this refund.");
    expect(f[0].p_failure_code).toBe("charge_already_refunded");
    expect(JSON.stringify(f[0])).not.toMatch(/alice|4242|555/);
  });
  it("a failed refund whose Stripe failure_reason is not code-shaped is stored as 'unknown'; a code-shaped one is kept; a succeeded refund carries no message", async () => {
    S.retrieve.mockResolvedValue({ ...made, status: "failed", failure_reason: HOSTILE });
    await refundCardPaymentPartial({ row: row(60_000, "re_1"), feeReturnedCents: null });
    S.retrieve.mockResolvedValue({ ...made, status: "failed", failure_reason: "lost_or_stolen_card" });
    await refundCardPaymentPartial({ row: row(60_000, "re_1"), feeReturnedCents: null });
    S.retrieve.mockResolvedValue({ ...made, status: "succeeded" });
    await refundCardPaymentPartial({ row: row(60_000, "re_1"), feeReturnedCents: null });
    const f = finishCalls() as Array<Record<string, unknown>>;
    expect(f.map((a) => [a.p_outcome, a.p_failure_code, a.p_failure_message_safe])).toEqual([
      ["failed", "unknown", "Stripe refused this refund."], ["failed", "lost_or_stolen_card", "Stripe refused this refund."], ["succeeded", null, null],
    ]);
  });
});

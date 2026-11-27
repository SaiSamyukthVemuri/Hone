import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const S = vi.hoisted(() => ({ rpc: vi.fn(), alerts: [] as Array<Record<string, unknown>>, alertKept: true as boolean }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc: (n: string, a: unknown) => S.rpc(n, a) }) }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlertDurably: async (a: Record<string, unknown>) => { S.alerts.push(a); return S.alertKept; } }));

import { flagChargeRefunds, flagStandaloneRefund, noRow, recordBilledRefundOperatorAlert, REFUND_REVIEW_ALERT_ROUTE } from "@/lib/billing/refund-review-flag";
import type Stripe from "stripe";

// Synthetic ids only. The webhook hands the database RAW closed values and learns "billed" from the answer; it decides nothing before the lock.

const event = { id: "evt_1", created: 1700000000 } as unknown as Stripe.Event;
const charge = (refunds: unknown) => ({ id: "ch_1", refunds }) as unknown as Stripe.Charge;
const list = (data: unknown[], has_more = false) => ({ object: "list", has_more, data });
const re = (id: string, amount: number, meta: Record<string, string> = {}) => ({ id, amount, status: "succeeded", currency: "cad", metadata: meta });
const reasons = () => S.rpc.mock.calls.map((c) => (c[1] as Record<string, unknown>).p_reason_code);

beforeEach(() => { S.rpc.mockReset(); S.alerts.length = 0; S.alertKept = true; });

describe("flagChargeRefunds", () => {
  it("passes EVERY refund in the list on its own, with the raw values and the metadata locator", async () => {
    S.rpc.mockResolvedValue({ data: [{ result: "flagged" }], error: null });
    const out = await flagChargeRefunds("att-1", event, charge(list([re("re_a", 3000), re("re_b", 4000, { hone_payment_refund_id: "11111111-1111-4111-8111-111111111111" })])));
    expect(out).toEqual({ kind: "billed", failClosed: null });
    expect(S.rpc.mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({ p_attempt_id: "att-1", p_stripe_refund_id: "re_a", p_amount_cents: 3000, p_currency: "cad", p_hone_refund_id: null, p_reason_code: "partial_dashboard_refund" }),
      expect.objectContaining({ p_stripe_refund_id: "re_b", p_amount_cents: 4000, p_hone_refund_id: "11111111-1111-4111-8111-111111111111" }),
    ]);
  });

  it("a legacy visit answers not_billed on the first refund: the older path and its alert run, nothing else is asked", async () => {
    S.rpc.mockResolvedValue({ data: [{ result: "not_billed" }], error: null });
    expect(await flagChargeRefunds("att-1", event, charge(list([re("re_a", 3000), re("re_b", 1000)])))).toEqual({ kind: "not_billed" });
    expect(S.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["has_more", list([re("re_a", 3000)], true)],
    ["a missing list", null],
    ["a list object that is not a list", { object: "x", has_more: false, data: [] }],
  ])("%s fails closed: one list_incomplete call, no per-refund decision", async (_n, refunds) => {
    S.rpc.mockResolvedValue({ data: [{ result: "billed" }], error: null });
    expect(await flagChargeRefunds("att-1", event, charge(refunds))).toEqual({ kind: "billed", failClosed: "list_incomplete" });
    expect(reasons()).toEqual(["list_incomplete"]);
  });

  it("a refund the database could not place (unknown_payment, invalid_input) fails closed", async () => {
    S.rpc.mockResolvedValue({ data: [{ result: "unknown_payment" }], error: null });
    expect(await flagChargeRefunds("att-1", event, charge(list([re("re_a", 3000)])))).toEqual({ kind: "billed", failClosed: "unplaceable_refund" });
  });

  it("a database that cannot answer THROWS (the route answers 500 and Stripe redelivers); it is never read as not billed", async () => {
    S.rpc.mockResolvedValue({ data: null, error: { code: "57014" } });
    await expect(flagChargeRefunds("att-1", event, charge(list([re("re_a", 3000)])))).rejects.toThrow(/unrecorded/);
    S.rpc.mockResolvedValue({ data: [], error: null });
    await expect(flagChargeRefunds("att-1", event, charge(list([re("re_a", 3000)])))).rejects.toThrow(/unrecorded/);
  });
});

describe("flagStandaloneRefund and noRow", () => {
  it("a standalone refund event is flagged from the refund object; the refusal path asks with its own reason and writes nothing", async () => {
    S.rpc.mockResolvedValue({ data: [{ result: "known" }], error: null });
    expect(await flagStandaloneRefund("att-1", event, re("re_a", 2500) as unknown as Stripe.Refund)).toEqual({ kind: "billed", failClosed: null });
    S.rpc.mockResolvedValue({ data: [{ result: "billed" }], error: null });
    expect(await noRow("att-1", event, "refund_evidence_refused")).toEqual({ kind: "billed", failClosed: "refund_evidence_refused" });
    expect(reasons()).toEqual(["partial_dashboard_refund", "refund_evidence_refused"]);
  });
});

describe("the operator alert of a billed fail-closed case", () => {
  it("carries NO studio, client or visit, a fixed route and message and a closed reason", async () => {
    await recordBilledRefundOperatorAlert("att-1", event, "list_incomplete");
    expect(S.alerts).toHaveLength(1);
    const a = S.alerts[0];
    expect(a).toMatchObject({ severity: "critical", event: "billed_refund_list_incomplete", route: REFUND_REVIEW_ALERT_ROUTE, stripeEventId: "evt_1", safeDetails: { attempt_id: "att-1", reason: "list_incomplete" } });
    for (const k of ["studioId", "clientId", "appointmentId", "resolutionNote"]) expect(a, k).not.toHaveProperty(k);
    expect(Object.keys(a.safeDetails as object).sort()).toEqual(["attempt_id", "reason"]);
  });

  it("throws when the alert could not be kept, so the event is redelivered", async () => {
    S.alertKept = false;
    await expect(recordBilledRefundOperatorAlert("att-1", event, "unplaceable_refund")).rejects.toThrow(/unrecorded/);
  });
});

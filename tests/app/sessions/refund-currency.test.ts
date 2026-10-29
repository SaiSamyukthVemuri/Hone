import { beforeEach, describe, expect, it, vi } from "vitest";

// #1035 Codex P1 #4369182087. The refund confirmation prints the PERSISTED
// attempt currency; the action refuses (refundPaymentChargeAttempt is never
// called) when that stored currency is unreadable or differs from what the
// card printed. The oracle is the refund helper.

const practitioner = { id: "prac-1", role: "owner", active: true };
const studio = { id: "studio-1", timezone: "America/Toronto" };
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ practitioner, studio }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => {} }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

const attemptLookup: { row: { currency?: unknown } | null } = { row: { currency: "usd" } };
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q; q.eq = () => q;
      q.maybeSingle = async () => ({ data: attemptLookup.row, error: null });
      return q;
    },
  }),
}));

const refund = vi.fn(async (_a: Record<string, unknown>) => ({
  ok: true as const, attemptId: "att-1", stripeRefundId: "re_1", refundedAt: "2026-08-02T00:00:00.000Z", refundAmountCents: 12000,
}));
vi.mock("@/lib/billing/payment-refund", () => ({ refundPaymentChargeAttempt: (a: Record<string, unknown>) => refund(a) }));

import { refundPaymentChargeAttemptAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions";

function form(shown: string | null) {
  const fd = new FormData();
  fd.set("attempt_id", "att-1");
  fd.set("client_id", "client-1");
  fd.set("session_id", "sess-1");
  if (shown !== null) fd.set("expected_currency", shown);
  return fd;
}
beforeEach(() => { refund.mockClear(); attemptLookup.row = { currency: "usd" }; });

describe("refund confirms the persisted attempt currency", () => {
  it("usd attempt, usd shown: refunds (control)", async () => {
    expect((await refundPaymentChargeAttemptAction(form("usd"))).ok).toBe(true);
    expect(refund).toHaveBeenCalledTimes(1);
  });
  it("cad attempt, cad shown: refunds (control)", async () => {
    attemptLookup.row = { currency: "cad" };
    expect((await refundPaymentChargeAttemptAction(form("cad"))).ok).toBe(true);
    expect(refund).toHaveBeenCalledTimes(1);
  });
  it.each([["cad"], ["eur"], [""], [null]] as const)("usd attempt but %j shown: refused, helper never called", async (shown) => {
    const res = await refundPaymentChargeAttemptAction(form(shown));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/currency shown for this charge no longer matches/i);
    expect(refund).toHaveBeenCalledTimes(0);
  });
  it.each([["eur"], [null], ["USD"]] as const)("stored currency %j: refused as unverifiable, helper never called", async (stored) => {
    attemptLookup.row = { currency: stored };
    const res = await refundPaymentChargeAttemptAction(form("usd"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/currency of this charge could not be verified/i);
    expect(refund).toHaveBeenCalledTimes(0);
  });
});

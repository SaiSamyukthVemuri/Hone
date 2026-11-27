import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// HON-123 (Codex P1): a card payment on a split bill is refunded through the split refund command. The older whole-payment refund writes only the attempt's own columns (the
// 0393 mirror then makes a legacy row), so the action refuses a billed attempt and never reaches Stripe. A legacy single-payment attempt is unchanged.

const practitioner = { id: "prac-1", role: "owner", active: true };
const studio = { id: "studio-1", timezone: "America/Toronto" };
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ practitioner, studio }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => {} }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
const lookup: { row: { currency: string; visit_bill_id: string | null } | null } = { row: { currency: "cad", visit_bill_id: null } };
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ from: () => { const q: Record<string, unknown> = {}; q.select = () => q; q.eq = () => q; q.maybeSingle = async () => ({ data: lookup.row, error: null }); return q; } }),
}));
const refund = vi.fn(async (_a: Record<string, unknown>) => ({ ok: true as const, attemptId: "att-1", stripeRefundId: "re_1", refundedAt: "2026-08-02T00:00:00.000Z", refundAmountCents: 10000 }));
vi.mock("@/lib/billing/payment-refund", () => ({ refundPaymentChargeAttempt: (a: Record<string, unknown>) => refund(a) }));
import { refundPaymentChargeAttemptAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions";

const form = () => { const fd = new FormData(); fd.set("attempt_id", "att-1"); fd.set("client_id", "c"); fd.set("session_id", "s"); fd.set("expected_currency", "cad"); return fd; };
beforeEach(() => { refund.mockClear(); lookup.row = { currency: "cad", visit_bill_id: null }; });

describe("the whole-payment refund is withdrawn for a billed card payment", () => {
  it("a billed attempt is refused with a plain sentence and Stripe is never asked", async () => {
    lookup.row = { currency: "cad", visit_bill_id: "bill-1" };
    const out = await refundPaymentChargeAttemptAction(form());
    expect(out).toMatchObject({ ok: false, outcome: "visit_billed" });
    if (!out.ok) expect(out.error).toBe("This visit is paid through the visit bill. Refund a payment from Payments for this visit (open Quick checkout from the calendar or dashboard).");
    expect(refund).not.toHaveBeenCalled();
  });
  it("control: an attempt with no bill refunds exactly as before", async () => {
    expect((await refundPaymentChargeAttemptAction(form())).ok).toBe(true);
    expect(refund).toHaveBeenCalledTimes(1);
  });
  it("the chart card withdraws the control for a billed visit (context gate in front of the sub-panel) and the page passes the flag", () => {
    const card = readFileSync("components/session-payment-prepare-card.tsx", "utf8");
    expect(card).toContain("<VisitBilledContext.Provider value={visitBilled}>");
    expect(card).toMatch(/function RefundSubPanelGate\(props[^)]*\)\s*\{\s*const billed = useContext\(VisitBilledContext\);\s*if \(billed\)/);
    expect(readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8")).toContain("visitBilled={visitBilled}");
  });
});

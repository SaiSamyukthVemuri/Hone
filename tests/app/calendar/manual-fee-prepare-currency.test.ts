import { beforeEach, describe, expect, it, vi } from "vitest";

// #1035 Codex P1 #4369182087. Preparing a no-show / late-cancellation fee: the
// card printed the studio's verified currency and posts it back; the action
// refuses (no attempt row is inserted) when it differs from the currency the
// server's eligibility holds now.

const practitioner = { id: "prac-1", role: "owner", active: true };
const studio = { id: "studio-1", timezone: "America/Toronto" };
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ practitioner, studio }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => {} }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

const inserted: Array<Record<string, unknown>> = [];
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: { id: "cpm-1", stripe_account_id: "acct_1", stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1" }, error: null });
      q.insert = (row: Record<string, unknown>) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: "att-1" }, error: null }) }) }; };
      return q;
    },
  }),
}));

let eligibility: unknown;
vi.mock("@/lib/billing/manual-fee-eligibility", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getManualFeeChargeEligibility: async () => eligibility,
}));

import { prepareManualFeeChargeAction } from "@/app/(app)/calendar/[id]/manual-fee-actions";

const eligible = (currency: string) => ({
  eligible: true, cardPaymentMethodId: "cpm-1", cardAuthorizationSignatureId: "sig-1", policyAcknowledgementId: "ack-1",
  policySnapshotHash: "h", amountCents: 5000, currency, timingClassification: "practitioner_asserted",
  appointment: { id: "appt-1" }, client: { id: "client-1", name: "A B" }, card: {}, cardAuthorization: {}, policyAcknowledgement: {}, existingAttempts: [],
});
function form(shown: string | null) {
  const fd = new FormData();
  fd.set("appointment_id", "appt-1");
  fd.set("charge_type", "no_show");
  fd.set("internal_note", "client did not arrive");
  if (shown !== null) fd.set("expected_currency", shown);
  return fd;
}
beforeEach(() => { inserted.length = 0; });

describe("fee prepare: displayed currency must equal the eligibility currency", () => {
  it.each([["usd", "usd"], ["cad", "cad"]])("%s studio, %s shown: reaches the insert in its own currency (control)", async (cur, shown) => {
    eligibility = eligible(cur);
    await prepareManualFeeChargeAction(form(shown));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].currency).toBe(cur);
  });
  it.each([["usd", "cad"], ["cad", "usd"], ["usd", null], ["usd", ""], ["usd", "eur"]] as const)("studio %s but %j shown: refused, nothing inserted", async (cur, shown) => {
    eligibility = eligible(cur);
    const res = await prepareManualFeeChargeAction(form(shown));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/currency shown for this fee no longer matches/i);
    expect(inserted).toHaveLength(0);
  });
  it("unknown jurisdiction (ineligible, currency null): refused, nothing inserted", async () => {
    eligibility = { eligible: false, blockingReasons: ["The studio's payment country and currency could not be verified. Refresh and try again."], currency: null, existingAttempts: [] };
    const res = await prepareManualFeeChargeAction(form("cad"));
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Manual late-cancel / no-show fees: the rules that make a fee safe, run as behaviour where a mock can
// reach them and as source pins where it cannot. Synthetic data, fake Stripe (never called), no live charge.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let role: "owner" | "practitioner" | "receptionist" = "owner";
const studio = { id: "studio-1", timezone: "America/Toronto" };
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "prac-1", role, active: true }, studio }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => {} }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

const inserted: Array<Record<string, unknown>> = [];
let insertError: { code: string } | null = null;
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: { id: "cpm-1", stripe_account_id: "acct_1", stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1" }, error: null });
      q.insert = (row: Record<string, unknown>) => {
        inserted.push(row);
        return { select: () => ({ single: async () => (insertError ? { data: null, error: insertError } : { data: { id: "att-1" }, error: null }) }) };
      };
      return q;
    },
  }),
}));
const updates: Array<Record<string, unknown>> = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ update: (row: Record<string, unknown>) => { updates.push(row); return { eq: async () => ({ error: null }) }; } }),
  }),
}));

let eligibility: unknown;
vi.mock("@/lib/billing/manual-fee-eligibility", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getManualFeeChargeEligibility: async () => eligibility,
}));

import { prepareManualFeeChargeAction } from "@/app/(app)/calendar/[id]/manual-fee-actions";
import { updateStudioFeeAmountsAction } from "@/app/(app)/settings/payments/fee-amounts-actions";
import { buildPaymentReceiptEmail, chargeReasonLabel } from "@/lib/email/templates/payment-receipt";

const eligible = (amountCents: number) => ({
  eligible: true, cardPaymentMethodId: "cpm-1", cardAuthorizationSignatureId: "sig-1", policyAcknowledgementId: "ack-1",
  policySnapshotHash: "h", amountCents, currency: "cad", timingClassification: "practitioner_asserted",
  appointment: { id: "appt-1" }, client: { id: "client-1", name: "A B" }, card: {}, cardAuthorization: {}, policyAcknowledgement: {}, existingAttempts: [],
});
function prepareForm(extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("appointment_id", "appt-1"); fd.set("charge_type", "no_show"); fd.set("internal_note", "did not arrive"); fd.set("expected_currency", "cad");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}
beforeEach(() => { inserted.length = 0; updates.length = 0; insertError = null; role = "owner"; eligibility = eligible(5000); });

describe("the amount is the saved fixed amount, never a posted one", () => {
  it("prepare writes eligibility.amountCents and ignores amount fields in the form", async () => {
    await prepareManualFeeChargeAction(prepareForm({ amount_cents: "1", amount: "1", fee_cents: "1", amount_dollars: "0.01" }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount_cents).toBe(5000);
  });
  it("the action never reads an amount from the form", () => {
    const src = codeOnly(read("app/(app)/calendar/[id]/manual-fee-actions.ts"));
    expect(src).not.toMatch(/formData\.get\(["'](amount|amount_cents|fee_cents|amount_dollars|percent)/);
  });
});

describe("duplicate protection at prepare", () => {
  it("a unique-violation from a double click / two tabs becomes the calm duplicate error and no second attempt", async () => {
    insertError = { code: "23505" };
    const r = await prepareManualFeeChargeAction(prepareForm());
    expect(r).toEqual({ ok: false, error: "A fee charge is already prepared for this appointment." });
    expect(inserted).toHaveLength(1);
  });
  it("an eligibility that already sees an active attempt never reaches the insert", async () => {
    eligibility = { eligible: false, blockingReasons: ["An active fee charge attempt already exists for this appointment."], existingAttempts: [], card: null };
    const r = await prepareManualFeeChargeAction(prepareForm());
    expect(r.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

describe("duplicate protection at execute: a deterministic key per attempt and reason", () => {
  const src = codeOnly(read("lib/billing/session-payment-charge.ts"));
  const start = src.indexOf("function buildIdempotencyKey");
  const fn = src.slice(start, src.indexOf("\n}\n", start) + 3);
  it("the key is built only from the attempt id and the charge reason", () => {
    expect(fn).toMatch(/hone:\$\{chargeReason\}:\$\{attemptId\}:v1/);
    expect(fn).not.toMatch(/Date\.now|new Date|Math\.random|randomUUID|crypto/);
  });
  it("it is computed once per execute and handed to the atomic claim, so a retry presents the same key", () => {
    expect(src).toMatch(/const idempotencyKey = buildIdempotencyKey\(attemptRow\.id, attemptRow\.charge_reason/);
    expect(src).toMatch(/claim_session_payment_charge_attempt/);
    expect(src).toMatch(/p_idempotency_key: idempotencyKey/);
  });
  it("the fee action has no other path to Stripe than the shared runner", () => {
    const actions = codeOnly(read("app/(app)/calendar/[id]/manual-fee-actions.ts"));
    expect(actions).not.toMatch(/paymentIntents\.(create|confirm)/);
    expect(actions).toMatch(/runSessionPaymentCharge\(/);
  });
});

describe("the owner-only fixed-amount setting", () => {
  const form = (late: string, noShow: string) => { const fd = new FormData(); fd.set("late_cancel_dollars", late); fd.set("no_show_dollars", noShow); return fd; };
  it("a practitioner and a receptionist cannot change the amounts", async () => {
    for (const r of ["practitioner", "receptionist"] as const) {
      role = r; updates.length = 0;
      const res = await updateStudioFeeAmountsAction(form("25", "50"));
      expect(res).toEqual({ ok: false, error: "Only the studio owner can change fee amounts." });
      expect(updates).toHaveLength(0);
    }
  });
  it("the owner saves whole dollars and two decimals as cents", async () => {
    const res = await updateStudioFeeAmountsAction(form("25", "49.99"));
    expect(res).toEqual({ ok: true });
    expect(updates[0]).toMatchObject({ late_cancel_fee_cents: 2500, no_show_fee_cents: 4999 });
  });
  it.each([["200.01", "10"], ["10", "-5"], ["10", "3.999"], ["abc", "10"], ["10", "1e3"], ["10", "20001"]])("refuses %s / %s and writes nothing", async (late, noShow) => {
    const res = await updateStudioFeeAmountsAction(form(late, noShow));
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it("the ceiling ($200.00) is accepted; a blank clears the amount to null", async () => {
    expect((await updateStudioFeeAmountsAction(form("200", ""))).ok).toBe(true);
    expect(updates[0]).toMatchObject({ late_cancel_fee_cents: 20000, no_show_fee_cents: null });
  });
});

describe("the fee receipt names the fee and the amount, never a session payment", () => {
  const build = (reason: string, livemode: boolean) => buildPaymentReceiptEmail({
    studioName: "Studio", studioContactEmail: null, clientName: "A B", chargeReasonLabel: chargeReasonLabel(reason), amountCents: 5000,
    currencyCode: "cad", chargedAt: new Date("2026-11-02T10:00:00Z"), stripePaymentIntentId: "pi_1", stripeChargeId: "ch_1", livemode,
  });
  it.each([["no_show_fee", "No-show fee"], ["late_cancellation_fee", "Late cancellation fee"]])("%s: %s, $50.00 CAD, test and live", (reason, label) => {
    for (const live of [false, true]) {
      const mail = build(reason, live);
      const body = `${mail.subject}\n${mail.text}`;
      expect(body).toContain(label);
      expect(body).toMatch(/\$50\.00/);
      expect(body).toMatch(/CAD/);
      expect(body).not.toMatch(/Session payment/i);
    }
  });
  it("an unknown reason falls back to a calm 'Payment', never a fee name", () => {
    expect(chargeReasonLabel("some_future_reason")).toBe("Payment");
  });
});

describe("no percentage engine, and no new policy model", () => {
  const FILES = [
    "app/(app)/calendar/[id]/manual-fee-actions.ts",
    "app/(app)/calendar/[id]/ManualFeeChargeCard.tsx",
    "app/(app)/settings/payments/fee-amounts-actions.ts",
    "lib/billing/manual-fee-eligibility.ts",
    "lib/billing/manual-fee-types.ts",
    "lib/billing/manual-fee-attempt-state.ts",
    "lib/billing/live-charge-reason-allowlist.ts",
    "lib/finance/collected-money-lines.ts",
  ];
  it.each(FILES)("%s computes no fee from a percentage, rate, basis points, tier or price", (rel) => {
    const code = codeOnly(read(rel));
    expect(code).not.toMatch(/percent|basis_?points|\bbps\b|fee_?rate|\btier(s|ed)?\b|\bpct\b|price_cents|resolveAuthoritativeSessionPaymentAmount/i);
  });
  it("the fee amount in eligibility comes from exactly the two saved columns", () => {
    const code = codeOnly(read("lib/billing/manual-fee-eligibility.ts"));
    expect(code).toContain('.select("late_cancel_fee_cents, no_show_fee_cents")');
    expect(code).toMatch(/studioRow\.late_cancel_fee_cents/);
    expect(code).toMatch(/studioRow\.no_show_fee_cents/);
  });
});

describe("the dashboard unpaid list does not turn a fee into a debt or a payment", () => {
  it("it reads session payments only", () => {
    const code = codeOnly(read("lib/dashboard/unpaid-attention.ts"));
    expect(code).toContain('.eq("charge_reason", "session_payment")');
    expect(code).not.toMatch(/no_show_fee|late_cancellation_fee|manual_fee/);
  });
});

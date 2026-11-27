import { beforeEach, describe, expect, it, vi } from "vitest";

// Split payments (HON-123): the trusted action wrappers. The 0394 commands are the authority (proved in tests/db); here we prove what the wrappers
// themselves own: the owner gate before any read, strict amount parsing, the studio taken from the session, closed codes to plain copy, and — the
// reserved-transfer rule — that a card refused by the database's card wall makes NO Stripe call and NO charge run.

const S = vi.hoisted(() => ({
  role: "owner" as "owner" | "staff",
  enabled: true,
  ledger: { bill: { id: "b", totalCents: 22500, currency: "cad", referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "x" }, cards: [], externals: [], refunds: [] } as unknown,
  command: { result: "recorded", id: "p1", state: "confirmed" } as { result: string; id: string | null; state: string | null },
  commandCalls: [] as [string, Record<string, unknown>][],
  insertError: null as null | { code: string },
  inserts: [] as unknown[],
  stripeCalls: 0,
  executeCalls: 0,
  prior: null as null | Record<string, unknown>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false, getStripe: () => { S.stripeCalls += 1; throw new Error("Stripe must not be called"); } }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "pr1", role: S.role }, studio: { id: "11111111-1111-4111-8111-111111111111", timezone: "UTC" } }),
}));
vi.mock("@/lib/billing/visit-payments", () => ({
  splitPaymentsEnabled: async () => S.enabled,
  loadVisitLedger: async () => ({ ok: true, ledger: S.ledger }),
  callCommand: async (fn: string, args: Record<string, unknown>) => { S.commandCalls.push([fn, args]); return S.command; },
}));
vi.mock("@/lib/billing/session-payment-eligibility", () => ({
  getSessionPaymentEligibility: async () => ({
    eligible: true, client: { id: "c1" }, card: { id: "card1" }, cardAuthorization: { signatureId: "sig1" },
    stripeAccountId: "acct_test", stripeCustomerId: "cus_test", stripePaymentMethodId: "pm_test", existingAttempts: [], jurisdiction: { currency: "cad" },
  }),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions", () => ({
  executeSessionPaymentChargeAction: async () => { S.executeCalls += 1; return { ok: true, outcome: "succeeded", stripePaymentIntentId: "pi", stripeChargeId: "ch" }; },
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, not: self, limit: self,
        maybeSingle: async () => (table === "sessions" ? { data: { id: "s1" }, error: null } : { data: S.prior, error: null }),
        insert: (row: unknown) => { S.inserts.push(row); return { select: () => ({ single: async () => (S.insertError ? { data: null, error: S.insertError } : { data: { id: "att1" }, error: null }) }) }; },
      });
      return chain;
    },
  }),
}));

import {
  confirmTransferAction, prepareSplitCardPaymentAction, recordExternalPaymentAction, refundExternalPaymentAction, runSplitCardPaymentAction,
  startSplitBillAction, voidTransferAction,
} from "@/app/(app)/visit-payment-actions";

const APPT = "22222222-2222-4222-8222-222222222222";
const SUB = "33333333-3333-4333-8333-333333333333";
const PAY = "44444444-4444-4444-8444-444444444444";
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

beforeEach(() => {
  S.role = "owner"; S.enabled = true; S.command = { result: "recorded", id: "p1", state: "confirmed" }; S.commandCalls = [];
  S.insertError = null; S.inserts = []; S.stripeCalls = 0; S.executeCalls = 0; S.prior = null;
  S.ledger = { bill: { id: "b", totalCents: 22500, currency: "cad", referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "x" }, cards: [], externals: [], refunds: [] };
});

describe("who may act", () => {
  it("a non-owner is refused every action before any read or command", async () => {
    S.role = "staff";
    const outs = [
      await startSplitBillAction(form({ appointment_id: APPT })),
      await recordExternalPaymentAction(form({ appointment_id: APPT, method: "paid_cash", amount_dollars: "50", submission_id: SUB })),
      await confirmTransferAction(form({ appointment_id: APPT, payment_id: PAY })),
      await voidTransferAction(form({ appointment_id: APPT, payment_id: PAY, reason: "x" })),
      await refundExternalPaymentAction(form({ appointment_id: APPT, payment_id: PAY, kind: "payment_reversal", amount_dollars: "5", reason: "x", submission_id: SUB })),
      await prepareSplitCardPaymentAction(form({ appointment_id: APPT, amount_dollars: "5", submission_id: SUB, expected_currency: "cad" })),
    ];
    for (const o of outs) expect(o).toMatchObject({ ok: false, code: "not_owner" });
    expect(S.commandCalls).toEqual([]);
    expect(S.inserts).toEqual([]);
  });
});

describe("amounts and ids are parsed strictly; the studio comes from the session, never the form", () => {
  it("records cash with the studio of the signed-in owner, whatever the form claims", async () => {
    const out = await recordExternalPaymentAction(form({ appointment_id: APPT, method: "paid_cash", amount_dollars: "50.00", submission_id: SUB, studio_id: "evil" }));
    expect(out).toMatchObject({ ok: true, code: "recorded" });
    expect(S.commandCalls[0][0]).toBe("record_visit_external_payment");
    expect(S.commandCalls[0][1]).toMatchObject({ p_studio_id: "11111111-1111-4111-8111-111111111111", p_amount_cents: 5000, p_submission_id: SUB, p_method: "paid_cash" });
  });
  it("refuses a malformed amount, method or id without calling the database", async () => {
    for (const bad of [{ amount_dollars: "1,000" }, { amount_dollars: "0" }, { amount_dollars: "5.123" }, { method: "bitcoin" }, { submission_id: "nope" }]) {
      const out = await recordExternalPaymentAction(form({ appointment_id: APPT, method: "paid_cash", amount_dollars: "50", submission_id: SUB, ...bad }));
      expect(out, JSON.stringify(bad)).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(S.commandCalls).toEqual([]);
  });
  it("a refusal from the database is shown in plain words and is not ok", async () => {
    S.command = { result: "reserved_for_pending_transfer", id: null, state: null };
    const out = await recordExternalPaymentAction(form({ appointment_id: APPT, method: "paid_cash", amount_dollars: "75", submission_id: SUB }));
    expect(out.ok).toBe(false);
    expect(out.note.message).toMatch(/^This amount is reserved for a pending transfer\./);
  });
  it("a repeated submit is shown as info, not an error", async () => {
    S.command = { result: "already_recorded", id: "p1", state: "confirmed" };
    const out = await recordExternalPaymentAction(form({ appointment_id: APPT, method: "paid_cash", amount_dollars: "50", submission_id: SUB }));
    expect(out).toMatchObject({ ok: true, code: "already_recorded" });
    expect(out.note.tone).toBe("info");
  });
});

describe("transfers and refunds", () => {
  it("confirm and void pass the payment id, and a void needs a reason", async () => {
    S.command = { result: "confirmed", id: PAY, state: "confirmed" };
    expect(await confirmTransferAction(form({ appointment_id: APPT, payment_id: PAY }))).toMatchObject({ ok: true, code: "confirmed" });
    expect(await voidTransferAction(form({ appointment_id: APPT, payment_id: PAY, reason: "" }))).toMatchObject({ ok: false, code: "invalid_input" });
    S.command = { result: "voided", id: PAY, state: "voided" };
    expect(await voidTransferAction(form({ appointment_id: APPT, payment_id: PAY, reason: "never arrived" }))).toMatchObject({ ok: true, code: "voided" });
    expect(S.commandCalls.map((c) => c[0])).toEqual(["confirm_visit_external_payment", "void_visit_external_payment"]);
  });
  it("an external refund names ONE payment, a kind, an amount and a reason; price reduction and payment reversal are the only kinds", async () => {
    S.command = { result: "requested", id: "r1", state: "succeeded" };
    const base = { appointment_id: APPT, payment_id: PAY, amount_dollars: "40.00", reason: "client unhappy", submission_id: SUB };
    expect(await refundExternalPaymentAction(form({ ...base, kind: "price_reduction" }))).toMatchObject({ ok: true });
    expect(S.commandCalls[0][1]).toMatchObject({ p_external_payment_id: PAY, p_attempt_id: null, p_amount_cents: 4000, p_kind: "price_reduction" });
    expect(await refundExternalPaymentAction(form({ ...base, kind: "discount" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await refundExternalPaymentAction(form({ ...base, kind: "payment_reversal", reason: "" }))).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("a card for reserved money never reaches Stripe", () => {
  const prep = () => prepareSplitCardPaymentAction(form({ appointment_id: APPT, amount_dollars: "75.00", submission_id: SUB, expected_currency: "cad" }));

  it("the database's card wall refuses (PY001): reserved message, no attempt, no charge run, ZERO Stripe calls", async () => {
    S.insertError = { code: "PY001" };
    const out = await prep();
    expect(out).toMatchObject({ ok: false, code: "PY001" });
    if (!out.ok) expect(out.note.message).toMatch(/^This amount is reserved for a pending transfer\./);
    expect(S.executeCalls).toBe(0);
    expect(S.stripeCalls).toBe(0);
  });
  it("more than is collectable (PY002) is refused the same way", async () => {
    S.insertError = { code: "PY002" };
    const out = await prep();
    expect(out).toMatchObject({ ok: false, code: "PY002" });
    expect(S.executeCalls).toBe(0);
    expect(S.stripeCalls).toBe(0);
  });
  it("a studio that is not switched on, or a visit with no bill, never inserts an attempt", async () => {
    S.enabled = false;
    expect(await prep()).toMatchObject({ ok: false, code: "split_payments_off" });
    S.enabled = true; S.ledger = { bill: null, cards: [], externals: [], refunds: [] };
    expect(await prep()).toMatchObject({ ok: false, code: "no_bill" });
    expect(S.inserts).toEqual([]);
    expect(S.stripeCalls).toBe(0);
  });
  it("a card in a different currency than the one shown is refused before anything is written", async () => {
    const out = await prepareSplitCardPaymentAction(form({ appointment_id: APPT, amount_dollars: "75", submission_id: SUB, expected_currency: "usd" }));
    expect(out).toMatchObject({ ok: false, code: "currency_changed" });
    expect(S.inserts).toEqual([]);
  });
  it("an accepted card writes ONE attempt row carrying the chosen amount and the submission id (the Stripe idempotency key is the attempt id)", async () => {
    const out = await prep();
    expect(out).toMatchObject({ ok: true, attemptId: "att1", amountCents: 7500, currency: "cad" });
    expect(S.inserts).toHaveLength(1);
    expect(S.inserts[0]).toMatchObject({ amount_cents: 7500, submission_id: SUB, status: "ready", currency: "cad", charge_reason: "session_payment" });
    expect(S.stripeCalls).toBe(0);   // preparing never calls Stripe
  });
  it("a repeated prepare (same submission, same amount) returns the first attempt and inserts nothing", async () => {
    S.prior = { id: "first-attempt", amount_cents: 7500, currency: "cad" };
    const out = await prep();
    expect(out).toMatchObject({ ok: true, attemptId: "first-attempt" });
    expect(S.inserts).toEqual([]);
    S.prior = { id: "first-attempt", amount_cents: 9999, currency: "cad" };
    expect(await prep()).toMatchObject({ ok: false, code: "submission_reused" });
  });
});

describe("running or re-checking a card payment", () => {
  it("only this studio's billed attempt on this visit is run; a non-uuid is unknown and runs nothing", async () => {
    expect(await runSplitCardPaymentAction(form({ appointment_id: APPT, attempt_id: "x" }))).toMatchObject({ outcome: "unknown" });
    expect(S.executeCalls).toBe(0);
  });
  it("an attempt that already succeeded is reported as succeeded without running the charge again", async () => {
    S.prior = { id: "a", status: "succeeded", currency: "cad" };
    expect(await runSplitCardPaymentAction(form({ appointment_id: APPT, attempt_id: PAY }))).toMatchObject({ outcome: "succeeded" });
    expect(S.executeCalls).toBe(0);
  });
  it("a ready attempt is run through the existing hardened charge, once per call", async () => {
    S.prior = { id: "a", status: "ready", currency: "cad" };
    expect(await runSplitCardPaymentAction(form({ appointment_id: APPT, attempt_id: PAY }))).toMatchObject({ outcome: "succeeded" });
    expect(S.executeCalls).toBe(1);
  });
});

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
  executeResult: null as null | Record<string, unknown>,
  sessions: [{ id: "s1", deleted_at: null, created_at: "2026-11-01T00:00:00Z" }] as Array<{ id: string; deleted_at: string | null; created_at: string }>,
  prior: null as null | Record<string, unknown>,
  refundCalls: [] as unknown[],
  refundOutcome: { outcome: "succeeded", message: "Refund recorded." } as { outcome: string; message: string },
  quote: 10000 as number | null,
  attemptMode: false as boolean | null,
  attemptReadable: true,
  injectAttempt: false,
  liveDeployment: false,
}));
vi.mock("@/lib/billing/appointment-settlement", () => ({ resolveAppointmentQuotedAmountCents: async () => S.quote }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => S.liveDeployment, getStripe: () => { S.stripeCalls += 1; throw new Error("Stripe must not be called"); } }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "pr1", role: S.role }, studio: { id: "11111111-1111-4111-8111-111111111111", timezone: "UTC" } }),
}));
vi.mock("@/lib/billing/visit-payments", () => ({
  splitPaymentsEnabled: async () => S.enabled,
  loadVisitLedger: async () => {
    const l = S.ledger as { cards: unknown[] };
    // the refund tests read the payment's persisted mode through the ledger (test = stripe_livemode is not true)
    return { ok: true, ledger: S.injectAttempt && S.attemptReadable ? { ...l, cards: [...l.cards, { kind: "card", id: "44444444-4444-4444-8444-444444444444", amountCents: 10000, status: "succeeded", at: "t", platformFeeCents: null, test: S.attemptMode !== true }] } : S.ledger };
  },
  readRefundRow: async (studioId: string, id: string) => ({ id, studioId, attemptId: "44444444-4444-4444-8444-444444444444", amountCents: 4000, status: "pending_stripe", source: "hone" }),
  callCommand: async (fn: string, args: Record<string, unknown>) => { S.commandCalls.push([fn, args]); return S.command; },
}));
vi.mock("@/lib/billing/payment-partial-refund", () => ({
  refundCardPaymentPartial: async (a: unknown) => { S.refundCalls.push(a); return S.refundOutcome; },
}));
vi.mock("@/lib/billing/session-payment-eligibility", () => ({
  getSessionPaymentEligibility: async () => ({
    eligible: true, client: { id: "c1" }, card: { id: "card1" }, cardAuthorization: { signatureId: "sig1" },
    stripeAccountId: "acct_test", stripeCustomerId: "cus_test", stripePaymentMethodId: "pm_test", existingAttempts: [], jurisdiction: { currency: "cad" },
  }),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions", () => ({
  executeSessionPaymentChargeAction: async () => { S.executeCalls += 1; return S.executeResult ?? { ok: true, outcome: "succeeded", stripePaymentIntentId: "pi", stripeChargeId: "ch" }; },
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      // sessions behaves like the table: .is("deleted_at", null) keeps live rows, .order("created_at"/"id", desc) sorts, maybeSingle takes the first.
      let liveOnly = false; let cols = "";
      Object.assign(chain, {
        select: (c?: string) => { cols = c ?? ""; return chain; }, eq: self, not: self, limit: self, order: self,
        is: (col: string, v: unknown) => { if (col === "deleted_at" && v === null) liveOnly = true; return chain; },
        maybeSingle: async () => {
          if (table !== "sessions") return { data: S.prior, error: null };
          const rows = S.sessions.filter((r) => !liveOnly || r.deleted_at === null).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
          return { data: rows[0] ? { id: rows[0].id } : null, error: null };
        },
        insert: (row: unknown) => { S.inserts.push(row); return { select: () => ({ single: async () => (S.insertError ? { data: null, error: S.insertError } : { data: { id: "att1" }, error: null }) }) }; },
      });
      return chain;
    },
  }),
}));

import {
  confirmTransferAction, prepareSplitCardPaymentAction, recordExternalPaymentAction, refundExternalPaymentAction, runSplitCardPaymentAction,
  startSplitBillAction, voidTransferAction, cancelSplitCardAttemptAction, refundCardPaymentAction, recheckCardRefundAction, resolveRefundReviewAction,
} from "@/app/(app)/visit-payment-actions";

const APPT = "22222222-2222-4222-8222-222222222222";
const SUB = "33333333-3333-4333-8333-333333333333";
const PAY = "44444444-4444-4444-8444-444444444444";
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

beforeEach(() => {
  S.attemptMode = false; S.attemptReadable = true; S.liveDeployment = false; S.injectAttempt = false;
  S.role = "owner"; S.enabled = true; S.command = { result: "recorded", id: "p1", state: "confirmed" }; S.commandCalls = [];
  S.executeResult = null; S.sessions = [{ id: "s1", deleted_at: null, created_at: "2026-11-01T00:00:00Z" }]; S.insertError = null; S.inserts = []; S.stripeCalls = 0; S.executeCalls = 0; S.prior = null; S.refundCalls = []; S.refundOutcome = { outcome: "succeeded", message: "Refund recorded." };
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
    S.prior = { id: "first-attempt", amount_cents: 7500, currency: "cad", appointment_id: APPT, status: "ready" };
    const out = await prep();
    expect(out).toMatchObject({ ok: true, attemptId: "first-attempt" });
    expect(S.inserts).toEqual([]);
    S.prior = { id: "first-attempt", amount_cents: 9999, currency: "cad", appointment_id: APPT, status: "ready" };
    expect(await prep()).toMatchObject({ ok: false, code: "submission_reused" });
    // P3(d): the same submission id on ANOTHER visit, or on an attempt that was cancelled or failed, is a reused id, not "the first attempt".
    S.prior = { id: "first-attempt", amount_cents: 7500, currency: "cad", appointment_id: "99999999-9999-4999-8999-999999999999", status: "ready" };
    expect(await prep()).toMatchObject({ ok: false, code: "submission_reused" });
    S.prior = { id: "first-attempt", amount_cents: 7500, currency: "cad", appointment_id: APPT, status: "cancelled" };
    expect(await prep()).toMatchObject({ ok: false, code: "submission_reused" });
  });
});

describe("the chart a split card payment attaches to (Codex P2 on #1827)", () => {
  const prepCard = () => prepareSplitCardPaymentAction(form({ appointment_id: APPT, amount_dollars: "50.00", expected_currency: "cad", submission_id: SUB }));
  it("a deleted chart is skipped: with a deleted chart and its live replacement, the attempt is attached to the replacement", async () => {
    S.sessions = [
      { id: "deleted-old", deleted_at: "2026-11-02T00:00:00Z", created_at: "2026-11-03T00:00:00Z" },
      { id: "live-replacement", deleted_at: null, created_at: "2026-11-01T00:00:00Z" },
    ];
    await prepCard();
    expect(S.inserts).toHaveLength(1);
    expect(S.inserts[0]).toMatchObject({ session_id: "live-replacement" });
  });
  it("only a deleted chart exists: nothing is prepared (no_session)", async () => {
    S.sessions = [{ id: "deleted-old", deleted_at: "2026-11-02T00:00:00Z", created_at: "2026-11-03T00:00:00Z" }];
    expect(await prepCard()).toMatchObject({ ok: false, code: "no_session" });
    expect(S.inserts).toHaveLength(0);
  });
  it("two live charts: the newest one, always", async () => {
    S.sessions = [
      { id: "older", deleted_at: null, created_at: "2026-11-01T00:00:00Z" },
      { id: "newer", deleted_at: null, created_at: "2026-11-05T00:00:00Z" },
    ];
    await prepCard();
    expect(S.inserts[0]).toMatchObject({ session_id: "newer" });
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

describe("a refused re-check is not proof of 'not charged' while Stripe may have the charge (Codex P1)", () => {
  const refusals = ["blocked", "authorization_not_current", "lineage_mismatch", "live_mode_blocked"] as const;
  it.each(refusals)("%s on a pending_stripe attempt stays UNKNOWN: no 'not charged', so no second charge is offered", async (outcome) => {
    S.prior = { id: "a", status: "pending_stripe", currency: "cad" };
    S.executeResult = { ok: false, outcome, error: "refused" };
    expect(await runSplitCardPaymentAction(form({ appointment_id: APPT, attempt_id: PAY }))).toMatchObject({ outcome: "unknown" });
  });
  it.each(refusals)("%s on a ready attempt that was never sent is a definite 'not charged'", async (outcome) => {
    S.prior = { id: "a", status: "ready", currency: "cad" };
    S.executeResult = { ok: false, outcome, error: "refused" };
    expect(await runSplitCardPaymentAction(form({ appointment_id: APPT, attempt_id: PAY }))).toMatchObject({ outcome: "failed" });
  });
  it("a terminal 'failed' from the executor is definite either way", async () => {
    S.prior = { id: "a", status: "pending_stripe", currency: "cad" };
    S.executeResult = { ok: false, outcome: "failed", error: "declined" };
    expect(await runSplitCardPaymentAction(form({ appointment_id: APPT, attempt_id: PAY }))).toMatchObject({ outcome: "failed" });
  });
});

describe("partial card refund", () => {
  beforeEach(() => { S.injectAttempt = true; });
  const f = (o: Record<string, string> = {}) => form({ appointment_id: APPT, attempt_id: PAY, kind: "payment_reversal", amount_dollars: "40.00", reason: "client unhappy", submission_id: SUB, ...o });

  it("a non-owner never reaches the database or Stripe", async () => {
    S.role = "staff";
    expect(await refundCardPaymentAction(f())).toMatchObject({ ok: false, code: "not_owner" });
    expect(S.commandCalls).toEqual([]);
    expect(S.refundCalls).toEqual([]);
  });
  it("the database refuses more than is refundable: Stripe is never asked", async () => {
    S.command = { result: "exceeds_refundable", id: null, state: null };
    const out = await refundCardPaymentAction(f({ amount_dollars: "75.00" }));
    expect(out).toMatchObject({ ok: false, code: "exceeds_refundable" });
    expect(S.refundCalls).toEqual([]);
  });
  // Codex P2 on #1827: a live deployment cannot refund a Stripe TEST payment; the refusal comes BEFORE any refund row exists (no pending row, no reserved capacity, no bill change).
  it("a live deployment and a TEST-card payment: refused with a fixed sentence, NO command (so no refund row, bill unchanged), Stripe never asked", async () => {
    S.liveDeployment = true; S.attemptMode = false;
    S.command = { result: "requested", id: "refund-row-1", state: "pending_stripe" };
    const before = JSON.stringify(S.ledger);
    for (const kind of ["payment_reversal", "price_reduction"]) {
      const out = await refundCardPaymentAction(f({ kind }));
      expect(out).toMatchObject({ ok: false, code: "payment_mode_mismatch" });
      expect(out.note.message).toBe("This payment was made in Stripe test mode, so it cannot be refunded from the live account. Nothing was changed.");
    }
    expect(S.commandCalls).toEqual([]);
    expect(S.refundCalls).toEqual([]);
    expect(S.stripeCalls).toBe(0);                              // Stripe is never touched
    expect(JSON.stringify(S.ledger)).toBe(before);              // the visit's ledger (balance, pending refunds, refundable) is byte-identical
  });
  it("a live deployment and a LIVE-card payment follows the existing path", async () => {
    S.liveDeployment = true; S.attemptMode = true;
    S.command = { result: "requested", id: "refund-row-1", state: "pending_stripe" };
    expect(await refundCardPaymentAction(f())).toMatchObject({ ok: true, refundId: "refund-row-1" });
    expect(S.commandCalls[0][0]).toBe("request_payment_refund");
    expect(S.refundCalls).toHaveLength(1);
  });
  it("an unreadable payment mode is refused before any command (never guessed)", async () => {
    S.attemptReadable = false;
    expect(await refundCardPaymentAction(f())).toMatchObject({ ok: false, code: "unavailable" });
    expect(S.commandCalls).toEqual([]);
  });
  it("a $40 refund is recorded by the command first, then sent to Stripe ONCE for that refund row", async () => {
    S.command = { result: "requested", id: "refund-row-1", state: "pending_stripe" };
    const out = await refundCardPaymentAction(f());
    expect(out).toMatchObject({ ok: true, refundId: "refund-row-1" });
    expect(S.commandCalls[0][0]).toBe("request_payment_refund");
    expect(S.commandCalls[0][1]).toMatchObject({ p_attempt_id: PAY, p_external_payment_id: null, p_amount_cents: 4000, p_kind: "payment_reversal" });
    expect(S.refundCalls).toHaveLength(1);
    expect(S.refundCalls[0]).toMatchObject({ row: { id: "refund-row-1", studioId: "11111111-1111-4111-8111-111111111111", amountCents: 4000 } });
  });
  it("a lost Stripe answer says Checking refund status, is not an error, and offers no second refund", async () => {
    S.command = { result: "requested", id: "refund-row-1", state: "pending_stripe" };
    S.refundOutcome = { outcome: "unknown", message: "Checking refund status" };
    const out = await refundCardPaymentAction(f());
    expect(out).toMatchObject({ ok: true, checking: true, refundId: "refund-row-1" });
    expect(out.note.message).toBe("Checking refund status");
  });
  it("a refusal by Stripe is shown plainly and not ok", async () => {
    S.command = { result: "requested", id: "refund-row-1", state: "pending_stripe" };
    S.refundOutcome = { outcome: "failed", message: "Stripe refused this refund. Nothing was returned." };
    expect(await refundCardPaymentAction(f())).toMatchObject({ ok: false });
  });
  it("a repeated request (same submission) re-checks the SAME row", async () => {
    S.command = { result: "already_requested", id: "refund-row-1", state: "pending_stripe" };
    await refundCardPaymentAction(f());
    expect(S.refundCalls[0]).toMatchObject({ row: { id: "refund-row-1" } });
  });
  it("kinds and amounts are validated before anything runs", async () => {
    for (const bad of [{ kind: "discount" }, { amount_dollars: "0" }, { reason: "" }, { attempt_id: "x" }] as Record<string, string>[]) {
      expect(await refundCardPaymentAction(f(bad)), JSON.stringify(bad)).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(S.commandCalls).toEqual([]);
  });
});

describe("durable recheck of a pending card refund (Codex P1)", () => {
  const RID = "55555555-5555-4555-8555-555555555555";
  const f = (o: Record<string, string> = {}) => form({ appointment_id: APPT, refund_id: RID, ...o });
  const pendingLedger = (status: string) => ({
    bill: { id: "b", totalCents: 22500, currency: "cad", referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "x" }, cards: [], externals: [],
    refunds: [{ id: RID, amountCents: 4000, kind: "payment_reversal", status, attemptId: PAY, externalPaymentId: null, reason: "r", at: "t" }],
  });
  it("is owner-only: a non-owner reaches nothing", async () => {
    S.role = "staff";
    expect(await recheckCardRefundAction(f())).toMatchObject({ ok: false, code: "not_owner" });
    expect(S.refundCalls).toEqual([]);
  });
  it("only a pending card refund of THIS visit is sent; an unknown id is not_found and Stripe is not asked", async () => {
    S.ledger = pendingLedger("pending_stripe");
    expect(await recheckCardRefundAction(f({ refund_id: "66666666-6666-4666-8666-666666666666" }))).toMatchObject({ ok: false, code: "not_found" });
    expect(S.refundCalls).toEqual([]);
  });
  it("a pending refund is sent again for the SAME row (its id is the Stripe key), after a reload", async () => {
    S.ledger = pendingLedger("pending_stripe");
    const out = await recheckCardRefundAction(f());
    expect(S.refundCalls).toHaveLength(1);
    expect(S.refundCalls[0]).toMatchObject({ row: { id: RID } });
    expect(out).toMatchObject({ ok: true, refundId: RID });
  });
  it("a refund that already settled is not sent again", async () => {
    S.ledger = pendingLedger("succeeded");
    await recheckCardRefundAction(f());
    expect(S.refundCalls).toEqual([]);
  });
  it("a lost answer keeps saying Checking refund status", async () => {
    S.ledger = pendingLedger("pending_stripe");
    S.refundOutcome = { outcome: "unknown", message: "Checking refund status" };
    expect(await recheckCardRefundAction(f())).toMatchObject({ ok: true, checking: true });
  });
});

describe("cancelling a prepared, unsent card payment (P3b)", () => {
  it("is owner-only, validates ids, and calls the database command with the studio from the session", async () => {
    S.role = "staff";
    expect(await cancelSplitCardAttemptAction(form({ appointment_id: APPT, attempt_id: PAY }))).toMatchObject({ ok: false, code: "not_owner" });
    expect(S.commandCalls).toEqual([]);
    S.role = "owner";
    expect(await cancelSplitCardAttemptAction(form({ appointment_id: APPT, attempt_id: "x" }))).toMatchObject({ ok: false, code: "invalid_input" });
    S.command = { result: "cancelled", id: PAY, state: "cancelled" };
    expect(await cancelSplitCardAttemptAction(form({ appointment_id: APPT, attempt_id: PAY }))).toMatchObject({ ok: true, code: "cancelled" });
    expect(S.commandCalls.at(-1)?.[0]).toBe("cancel_split_card_attempt");
    S.command = { result: "not_cancellable", id: PAY, state: "pending_stripe" };
    expect(await cancelSplitCardAttemptAction(form({ appointment_id: APPT, attempt_id: PAY }))).toMatchObject({ ok: false, code: "not_cancellable" });
  });
});

describe("resolveRefundReviewAction (a refund made in the Stripe dashboard)", () => {
  const REV = "55555555-5555-4555-8555-555555555555";
  it("a non-owner is refused before the database is asked", async () => {
    S.role = "staff";
    const r = await resolveRefundReviewAction(form({ appointment_id: APPT, review_id: REV }));
    expect(r.code).toBe("not_owner");
    expect(S.commandCalls).toEqual([]);
  });
  it("sends ONLY the review id (no amount, no studio from the form), and maps the database's answer to plain copy", async () => {
    S.role = "owner";
    S.command = { result: "resolved", id: null, state: null };
    const r = await resolveRefundReviewAction(form({ appointment_id: APPT, review_id: REV, amount_dollars: "999", studio_id: "x" }));
    expect(S.commandCalls).toEqual([["resolve_payment_refund_review", { p_review_id: REV }]]);
    expect(r.ok).toBe(true);
    expect(r.note.message).toMatch(/Recorded/);
    S.command = { result: "refund_pending", id: null, state: null };
    expect((await resolveRefundReviewAction(form({ appointment_id: APPT, review_id: REV }))).ok).toBe(false);
  });
  it("malformed ids are refused", async () => {
    S.role = "owner";
    expect((await resolveRefundReviewAction(form({ appointment_id: "x", review_id: REV }))).code).toBe("invalid_input");
    expect((await resolveRefundReviewAction(form({ appointment_id: APPT, review_id: "x" }))).code).toBe("invalid_input");
  });
});

describe("the split bill is made at the reviewed fee (Codex P2)", () => {
  it("adjusts $100 to $80: the command gets 8000 and the reason, so the bill is $80", async () => {
    S.command = { result: "created", id: "b1", state: null };
    const out = await startSplitBillAction(form({ appointment_id: APPT, reference_fee_cents: "10000", final_amount_dollars: "80.00", adjustment_reason: "Loyalty discount" }));
    expect(out.ok === true || out.code === "created" || out.code === "exists").toBe(true);
    expect(S.commandCalls[0][0]).toBe("ensure_visit_bill");
    expect(S.commandCalls[0][1]).toMatchObject({ p_final_cents: 8000, p_fee_adjustment_reason: "Loyalty discount" });
  });
  it("no adjustment: the booked price (null final), no reason", async () => {
    await startSplitBillAction(form({ appointment_id: APPT, reference_fee_cents: "10000" }));
    expect(S.commandCalls[0][1]).toMatchObject({ p_final_cents: null, p_fee_adjustment_reason: null });
  });
  // Codex P2 on #1827: the price moved after checkout loaded. The bill must not be made at a price the owner never reviewed.
  it("the reviewed fee no longer matches the current quote: refused as fee_changed, no command, nothing recorded", async () => {
    S.quote = 12000;                                    // the service price went up to $120 while checkout showed $100
    const out = await startSplitBillAction(form({ appointment_id: APPT, reference_fee_cents: "10000" }));
    expect(out).toMatchObject({ ok: false, code: "fee_changed" });
    expect(out.note.message).toMatch(/price changed/i);
    expect(S.commandCalls).toEqual([]);
    S.quote = 10000;
  });
  it("an unreadable current quote is refused too (never a blind bill); a post without the reviewed fee is refused", async () => {
    S.quote = null;
    expect(await startSplitBillAction(form({ appointment_id: APPT, reference_fee_cents: "10000" }))).toMatchObject({ ok: false, code: "fee_changed" });
    S.quote = 10000;
    expect(await startSplitBillAction(form({ appointment_id: APPT }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(S.commandCalls).toEqual([]);
  });
  it("a malformed fee is refused before any command", async () => {
    const out = await startSplitBillAction(form({ appointment_id: APPT, reference_fee_cents: "10000", final_amount_dollars: "eighty" }));
    expect(out).toMatchObject({ ok: false, code: "invalid_input" });
    expect(S.commandCalls).toEqual([]);
  });
});

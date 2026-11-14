import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { feeAttemptState } from "@/lib/billing/manual-fee-attempt-state";
import { feeExecuteBlock, feePrepareBlock, ONE_FEE_PER_APPOINTMENT_MESSAGE, type OneFeeAttempt } from "@/lib/billing/manual-fee-one-per-appointment";

// E1 (Sam, 13 Nov): "Close declined attempt". Fake Stripe, synthetic rows, no network, no database.
// The function cancels the attempt's OWN PaymentIntent and records stripe_status='canceled' only from
// Stripe's confirmed response. It must never create a PaymentIntent.

const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const STUDIO = "11111111-1111-4111-8111-111111111111";
const PI = "pi_declined_1";

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  readError: null as unknown,
  updates: [] as Array<Record<string, unknown>>,
  updateRows: [{ id: "x" }] as unknown[],
  updateError: null as unknown,
  retrieveReply: null as unknown,
  retrieveError: null as unknown,
  cancelReply: null as unknown,
  cancelError: null as unknown,
  retrieves: 0,
  cancels: 0,
  creates: 0,
  alerts: [] as Array<{ severity: string; event: string }>,
}));

const fakeStripe = {
  paymentIntents: {
    create: async () => {
      h.creates += 1;
      throw new Error("a PaymentIntent must NEVER be created by close");
    },
    retrieve: async () => {
      h.retrieves += 1;
      if (h.retrieveError) throw h.retrieveError;
      return h.retrieveReply;
    },
    cancel: async () => {
      h.cancels += 1;
      if (h.cancelError) throw h.cancelError;
      return h.cancelReply;
    },
  },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false, getStripe: () => fakeStripe }));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({ getSessionPaymentStripe: () => fakeStripe }));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (i: { severity: string; event: string }) => {
    h.alerts.push({ severity: i.severity, event: i.event });
  },
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from() {
      let isUpdate = false;
      let payload: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};
      for (const m of ["eq", "is", "in", "neq", "order", "limit"]) q[m] = () => q;
      q.select = () => {
        if (isUpdate) {
          h.updates.push(payload);
          return Promise.resolve({ data: h.updateRows, error: h.updateError });
        }
        return q;
      };
      q.update = (p: Record<string, unknown>) => {
        isUpdate = true;
        payload = p;
        return q;
      };
      q.maybeSingle = async () => ({ data: h.row, error: h.readError });
      return q;
    },
  }),
}));

const { closeDeclinedFeeAttempt } = await import("@/lib/billing/close-declined-fee-attempt");

const ROW = {
  id: ATTEMPT, studio_id: STUDIO, client_id: "c1", appointment_id: "a1", charge_reason: "no_show_fee",
  status: "failed", amount_cents: 5000, currency: "cad", stripe_livemode: false, stripe_account_id: "acct_test",
  stripe_payment_intent_id: PI, stripe_status: "requires_payment_method", stripe_charge_id: null, charged_at: null,
};
const pi = (over: Record<string, unknown> = {}) => ({
  id: PI, status: "requires_action", amount: 5000, currency: "cad", livemode: false, amount_received: 0,
  metadata: { hone_session_payment_charge_attempt_id: ATTEMPT }, ...over,
});
const run = () => closeDeclinedFeeAttempt({ attemptId: ATTEMPT, studioId: STUDIO });
/** What the card/prepare logic would then see for the row after the call. */
const stateAfter = () =>
  feeAttemptState(
    { status: "failed", failure_code: "card_declined", has_payment_intent: true, stripe_status: (h.updates[0]?.stripe_status as string) ?? (ROW.stripe_status as string), charged_at: null, stripe_charge_id: null },
    new Date(),
  );

beforeEach(() => {
  h.row = { ...ROW };
  h.readError = null;
  h.updates = [];
  h.updateRows = [{ id: "x" }];
  h.updateError = null;
  h.retrieveReply = pi();
  h.retrieveError = null;
  h.cancelReply = pi({ status: "canceled" });
  h.cancelError = null;
  h.retrieves = h.cancels = h.creates = 0;
  h.alerts = [];
});

describe("closes ONLY after Stripe confirms canceled with nothing captured", () => {
  for (const status of ["requires_action", "requires_payment_method", "requires_confirmation"]) {
    it(`${status}: cancels that same PaymentIntent once, records canceled, frees the appointment, creates nothing`, async () => {
      h.retrieveReply = pi({ status });
      const r = await run();
      expect(r).toMatchObject({ ok: true, outcome: "closed" });
      expect(h.cancels).toBe(1);
      expect(h.creates, "no second PaymentIntent, ever").toBe(0);
      expect(h.updates).toEqual([{ stripe_status: "canceled" }]);
      expect(stateAfter()).toMatchObject({ blocksNewCharge: false });
    });
  }
  it("a PaymentIntent already canceled on Stripe: no cancel call, just records the confirmed fact", async () => {
    h.retrieveReply = pi({ status: "canceled" });
    expect(await run()).toMatchObject({ ok: true, outcome: "closed" });
    expect(h.cancels).toBe(0);
    expect(h.updates).toEqual([{ stripe_status: "canceled" }]);
  });
  it("an attempt already recorded as canceled is a no-op (no Stripe call at all)", async () => {
    h.row = { ...ROW, stripe_status: "canceled" };
    expect(await run()).toMatchObject({ ok: true, outcome: "already_closed" });
    expect(h.retrieves + h.cancels + h.creates).toBe(0);
  });
});

// End to end at the unit level, through the REAL appointment gate (the one prepare and execute use), not only the card state:
// what the close function writes is fed back as the attempt row, so "freed once the provider proves canceled" is proven by composition.
describe("the appointment is freed by the close function's own write, and only by it", () => {
  const AT = "2026-11-12T10:00:00.000Z";
  const NOW = new Date("2026-11-12T12:00:00.000Z");
  const attemptAfter = (): OneFeeAttempt => ({
    id: ATTEMPT, charge_type: "no_show", status: "failed", failure_code: "card_declined", created_at: AT, updated_at: AT,
    stripe_payment_intent_id: PI, stripe_status: (h.updates[0]?.stripe_status as string) ?? (ROW.stripe_status as string),
    charged_at: null, stripe_charge_id: null,
  });
  it("BEFORE the close: a declined attempt holding a live PaymentIntent blocks a new fee of either type", () => {
    const before: OneFeeAttempt = { ...attemptAfter(), stripe_status: ROW.stripe_status as string };
    expect(feePrepareBlock([before], "no_show", NOW)).not.toBeNull();
    expect(feePrepareBlock([before], "late_cancel", NOW)).toBe(ONE_FEE_PER_APPOINTMENT_MESSAGE);
    const fresh = { id: "44444444-4444-4444-8444-444444444444", created_at: "2026-11-12T11:00:00.000Z" };
    expect(feeExecuteBlock(fresh, [before], NOW)).not.toBeNull();
  });
  it("HAPPY PATH: metadata and mode match, Stripe says canceled with nothing captured: closed, and prepare and execute are then free for both types", async () => {
    h.retrieveReply = pi({ status: "requires_payment_method" });
    expect(await run()).toMatchObject({ ok: true, outcome: "closed", appointmentId: "a1" });
    expect(h.updates).toEqual([{ stripe_status: "canceled" }]);
    expect(feePrepareBlock([attemptAfter()], "no_show", NOW)).toBeNull();
    expect(feePrepareBlock([attemptAfter()], "late_cancel", NOW)).toBeNull();
    // A NEW fee attempt, created after the close, may execute beside the closed one.
    const fresh = { id: "44444444-4444-4444-8444-444444444444", created_at: "2026-11-12T11:00:00.000Z" };
    expect(feeExecuteBlock(fresh, [attemptAfter()], NOW)).toBeNull();
  });
  for (const [name, over] of [
    ["metadata names another attempt", { metadata: { hone_session_payment_charge_attempt_id: "someone-else" } }],
    ["metadata missing", { metadata: {} }],
    ["mode differs", { livemode: true }],
  ] as const) {
    it(`MISMATCH (${name}): nothing is cancelled or written and the appointment STAYS blocked`, async () => {
      h.retrieveReply = pi({ status: "requires_payment_method", ...over });
      expect(await run()).toMatchObject({ ok: false, outcome: "unclear" });
      expect(h.cancels).toBe(0);
      expect(h.updates).toHaveLength(0);
      expect(feePrepareBlock([attemptAfter()], "no_show", NOW)).not.toBeNull();
      expect(feePrepareBlock([attemptAfter()], "late_cancel", NOW)).toBe(ONE_FEE_PER_APPOINTMENT_MESSAGE);
    });
  }
});

describe("anything unconfirmed, unknown or money-bearing BLOCKS and writes nothing", () => {
  it("the cancel call FAILS: no write, status unclear, still blocked", async () => {
    h.cancelError = new Error("network down");
    const r = await run();
    expect(r).toMatchObject({ ok: false, outcome: "unclear" });
    expect(h.updates).toHaveLength(0);
    expect(stateAfter()).toMatchObject({ blocksNewCharge: true });
    expect(h.alerts.some((a) => a.severity === "critical")).toBe(true);
  });
  for (const [name, reply] of [
    ["not canceled", pi({ status: "requires_action" })],
    ["a different amount", pi({ status: "canceled", amount: 4000 })],
    ["a different currency", pi({ status: "canceled", currency: "usd" })],
    ["a different id", pi({ status: "canceled", id: "pi_other" })],
    ["captured money on the response", pi({ status: "canceled", amount_received: 100 })],
  ] as const) {
    it(`a cancel response that is ${name}: unclear, no write`, async () => {
      h.cancelReply = reply;
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "unclear" });
      expect(h.updates).toHaveLength(0);
    });
  }
  for (const status of ["processing", "requires_capture", "succeeded", "weird"]) {
    it(`PaymentIntent in ${status}: never cancelled, no write`, async () => {
      h.retrieveReply = pi({ status });
      expect(await run()).toMatchObject({ ok: false, outcome: "unclear" });
      expect(h.cancels).toBe(0);
      expect(h.updates).toHaveLength(0);
    });
  }
  it("money already received on the PaymentIntent: never cancelled, critical alert", async () => {
    h.retrieveReply = pi({ amount_received: 5000, status: "succeeded" });
    expect(await run()).toMatchObject({ ok: false, outcome: "unclear" });
    expect(h.cancels).toBe(0);
    expect(h.alerts.some((a) => a.severity === "critical")).toBe(true);
  });
  for (const [name, over] of [
    ["amount differs from the attempt", { amount: 4999 }],
    ["currency differs", { currency: "usd" }],
    ["mode differs", { livemode: true }],
    ["id differs", { id: "pi_other" }],
    ["metadata names another attempt", { metadata: { hone_session_payment_charge_attempt_id: "someone-else" } }],
    ["metadata missing", { metadata: {} }],
  ] as const) {
    it(`identity check: ${name} -> not this attempt's PaymentIntent: never cancelled, no write`, async () => {
      h.retrieveReply = pi(over);
      expect(await run()).toMatchObject({ ok: false, outcome: "unclear" });
      expect(h.cancels).toBe(0);
      expect(h.updates).toHaveLength(0);
    });
  }
  it("retrieve fails: unclear, nothing cancelled or written", async () => {
    h.retrieveError = new Error("boom");
    expect(await run()).toMatchObject({ ok: false, outcome: "unclear" });
    expect(h.cancels + h.updates.length).toBe(0);
  });
  it("no PaymentIntent id stored: unclear and NO Stripe call at all (the no-intent path belongs to E2)", async () => {
    h.row = { ...ROW, stripe_payment_intent_id: null };
    expect(await run()).toMatchObject({ ok: false, outcome: "unclear" });
    expect(h.retrieves + h.cancels + h.creates).toBe(0);
  });
  it("Stripe confirmed but the database write did not land: unclear (the appointment stays blocked)", async () => {
    h.updateRows = [];
    expect(await run()).toMatchObject({ ok: false, outcome: "unclear" });
    h.updateRows = [{ id: "x" }];
    h.updateError = { code: "XX000" };
    expect(await run()).toMatchObject({ ok: false, outcome: "unclear" });
  });
});

describe("only a failed, uncaptured MANUAL FEE attempt of this mode is closeable", () => {
  for (const [name, over] of [
    ["a session_payment", { charge_reason: "session_payment" }],
    ["a ready attempt", { status: "ready" }],
    ["a succeeded attempt", { status: "succeeded" }],
    ["a pending_stripe attempt", { status: "pending_stripe" }],
    ["a failed attempt that has a capture time", { charged_at: "2026-11-01T10:00:00Z" }],
    ["a failed attempt that has a charge id", { stripe_charge_id: "ch_x" }],
    ["the other mode", { stripe_livemode: true }],
  ] as const) {
    it(`${name}: not eligible, no Stripe call`, async () => {
      h.row = { ...ROW, ...over };
      expect(await run()).toMatchObject({ ok: false, outcome: "not_eligible" });
      expect(h.retrieves + h.cancels + h.creates + h.updates.length).toBe(0);
    });
  }
  it("a foreign or missing attempt is not found", async () => {
    h.row = null;
    expect(await run()).toMatchObject({ ok: false, outcome: "not_found" });
    h.row = { ...ROW };
    h.readError = { code: "XX000" };
    expect(await run()).toMatchObject({ ok: false, outcome: "not_found" });
  });
});

describe("the control is OFFERED only where it can apply (the server re-verifies everything)", () => {
  const base = { status: "failed", failure_code: "card_declined" };
  it("a failed row holding a PaymentIntent, no capture, not yet proven", () => {
    expect(feeAttemptState({ ...base, has_payment_intent: true, stripe_status: "requires_payment_method" }, new Date()).mayCloseDeclined).toBe(true);
    expect(feeAttemptState({ ...base, has_payment_intent: true, stripe_status: null }, new Date()).mayCloseDeclined).toBe(true);
  });
  it("never when there is no PaymentIntent, a capture, or it is already proven canceled", () => {
    expect(feeAttemptState({ ...base, has_payment_intent: false, stripe_status: null }, new Date()).mayCloseDeclined).toBeFalsy();
    expect(feeAttemptState({ ...base, has_payment_intent: true, charged_at: "2026-11-01T10:00:00Z" }, new Date()).mayCloseDeclined).toBeFalsy();
    expect(feeAttemptState({ ...base, has_payment_intent: true, stripe_charge_id: "ch_x" }, new Date()).mayCloseDeclined).toBeFalsy();
    expect(feeAttemptState({ ...base, has_payment_intent: true, stripe_status: "canceled" }, new Date()).mayCloseDeclined).toBeFalsy();
  });
});

describe("source shape: one cancel site, no create, owner-only action", () => {
  const root = process.cwd();
  const runner = readFileSync(path.join(root, "lib/billing/session-payment-charge.ts"), "utf8");
  const close = readFileSync(path.join(root, "lib/billing/close-declined-fee-attempt.ts"), "utf8");
  it("exactly one paymentIntents.cancel( across both modules, inside cancelPaymentIntentConfirmed; the finalizer and close both use it", () => {
    expect(runner.match(/paymentIntents\.cancel\(/g)).toHaveLength(1);
    expect(close.match(/paymentIntents\.cancel\(/g)).toBeNull();
    const helper = runner.slice(runner.indexOf("export async function cancelPaymentIntentConfirmed"));
    expect(helper.slice(0, 700)).toContain("paymentIntents.cancel(");
    expect(runner.slice(runner.indexOf("async function finalizeRequiresActionPaymentIntent"))).toContain("cancelPaymentIntentConfirmed(");
    expect(close).toContain("cancelPaymentIntentConfirmed(");
  });
  it("the close function never creates, confirms, captures or refunds anything", () => {
    expect(close).not.toMatch(/paymentIntents\.(create|confirm|capture)|refunds\.create|charges\.create/);
  });
  it("J1: exactly the finalizer and close-declined import/use cancelPaymentIntentConfirmed - a new caller fails this test", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") walk(rel); continue; }
        if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && readFileSync(path.join(root, rel), "utf8").includes("cancelPaymentIntentConfirmed")) files.push(rel);
      }
    };
    for (const d of ["app", "lib", "components"]) walk(d);
    expect(files.sort()).toEqual(["lib/billing/close-declined-fee-attempt.ts", "lib/billing/session-payment-charge.ts"]);
  });
  it("J2: the manual-review queue surfaces a webhook terminal_mismatch for FEE rows (reason-agnostic) and this module's own critical alerts", async () => {
    const wh = readFileSync(path.join(root, "lib/billing/payment-webhook-reconciliation.ts"), "utf8");
    expect(wh).not.toMatch(/\.(eq|in|neq)\(\s*"charge_reason"/);
    expect(wh).not.toMatch(/attempt\.charge_reason\s*(===|!==)\s*"(no_show_fee|late_cancellation_fee|session_payment)"/);
    const { isPaymentManualReviewEvent } = await import("@/lib/billing/payment-manual-review");
    expect(isPaymentManualReviewEvent("payment_intent_succeeded_local_terminal_mismatch")).toBe(true);
    expect(isPaymentManualReviewEvent("payment_intent_failed_local_terminal_mismatch")).toBe(true);
    // our own unclear alert must be visible in the queue too (the prefix is what the queue keys on)
    expect(isPaymentManualReviewEvent("payment_charge_close_declined_unclear")).toBe(true);
    expect(close).toContain('event: "payment_charge_close_declined_unclear"');
    expect(close).toContain('event: "payment_charge_declined_attempt_closed"');
  });
  it("the server action checks the owner role before calling the close function", () => {
    const src = readFileSync(path.join(root, "app/(app)/calendar/[id]/manual-fee-actions.ts"), "utf8");
    const a = src.slice(src.indexOf("export async function closeDeclinedFeeAttemptAction"));
    expect(a.indexOf('practitioner.role !== "owner"')).toBeGreaterThan(-1);
    expect(a.indexOf('practitioner.role !== "owner"')).toBeLessThan(a.indexOf("closeDeclinedFeeAttempt({"));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The owner's decision: after Hone records a declined session payment failed, close the ORIGINAL Stripe attempt. Verify first,
// retry only the cancel, never touch a replacement payment. Fake Stripe, synthetic rows, no network, no database.

const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT = "99999999-9999-4999-8999-999999999999";
const STUDIO = "11111111-1111-4111-8111-111111111111";
const PI = "pi_old_declined";
const NEW_PI = "pi_replacement";

type Filter = [string, unknown];
const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>>,
  readError: null as unknown,
  updates: [] as Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  updateRows: [{ id: "x" }] as unknown[],
  retrieveReply: null as unknown,
  retrieveError: null as unknown,
  cancelReply: null as unknown,
  cancelError: null as unknown,
  retrieveIds: [] as string[],
  cancelIds: [] as string[],
  creates: 0,
  alerts: [] as Array<{ severity: string; event: string }>,
}));

const fakeStripe = {
  paymentIntents: {
    create: async () => {
      h.creates += 1;
      throw new Error("never creates");
    },
    retrieve: async (id: string) => {
      h.retrieveIds.push(id);
      if (h.retrieveError) throw h.retrieveError;
      return h.retrieveReply;
    },
    cancel: async (id: string) => {
      h.cancelIds.push(id);
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
      const filters: Array<[string, unknown]> = [];
      const q: Record<string, unknown> = {};
      q.eq = (c: string, v: unknown) => (filters.push([c, v]), q);
      q.is = (c: string, v: unknown) => (filters.push([c, v]), q);
      q.select = () => {
        if (isUpdate) {
          h.updates.push({ payload, filters });
          return Promise.resolve({ data: h.updateRows, error: null });
        }
        return q;
      };
      q.update = (p: Record<string, unknown>) => {
        isUpdate = true;
        payload = p;
        return q;
      };
      q.maybeSingle = async () => {
        const id = filters.find(([c]) => c === "id")?.[1] as string;
        return { data: h.rows[id] ?? null, error: h.readError };
      };
      return q;
    },
  }),
}));

const { cancelDeclinedSessionIntent, CLEANUP_RETRY_WINDOW_MS } = await import("@/lib/billing/cancel-declined-session-intent");

const ROW = {
  id: ATTEMPT, studio_id: STUDIO, client_id: "c1", charge_reason: "session_payment", status: "failed",
  amount_cents: 22500, currency: "cad", stripe_livemode: false, stripe_account_id: "acct_test",
  stripe_payment_intent_id: PI, stripe_status: "requires_payment_method", charged_at: null, stripe_charge_id: null,
};
const REPLACEMENT_ROW = { ...ROW, id: REPLACEMENT, status: "pending_stripe", stripe_payment_intent_id: NEW_PI, stripe_status: "requires_payment_method" };
const pi = (over: Record<string, unknown> = {}) => ({
  id: PI, status: "requires_payment_method", amount: 22500, currency: "cad", livemode: false, amount_received: 0,
  metadata: { hone_session_payment_charge_attempt_id: ATTEMPT }, ...over,
});
const NOW = 1_800_000_000_000;
const run = (over: Partial<Parameters<typeof cancelDeclinedSessionIntent>[0]> = {}) =>
  cancelDeclinedSessionIntent({
    attemptId: ATTEMPT, studioId: STUDIO, eventPaymentIntentId: PI,
    eventCreatedSeconds: NOW / 1000 - 60, now: () => NOW, ...over,
  });

beforeEach(() => {
  h.rows = { [ATTEMPT]: { ...ROW }, [REPLACEMENT]: { ...REPLACEMENT_ROW } };
  h.readError = null;
  h.updates = [];
  h.updateRows = [{ id: "x" }];
  h.retrieveReply = pi();
  h.retrieveError = null;
  h.cancelReply = pi({ status: "canceled" });
  h.cancelError = null;
  h.retrieveIds = [];
  h.cancelIds = [];
  h.creates = 0;
  h.alerts = [];
});

const touchedReplacement = () =>
  h.updates.some((u) => u.filters.some(([c, v]) => c === "id" && v === REPLACEMENT)) ||
  h.cancelIds.includes(NEW_PI) || h.retrieveIds.includes(NEW_PI);

describe("closing the original attempt of a failed, declined session payment", () => {
  it("cancels exactly the stored intent, records canceled from Stripe's answer on THIS row only, leaves status failed", async () => {
    expect(await run()).toEqual({ outcome: "canceled" });
    expect(h.cancelIds).toEqual([PI]);
    expect(h.creates).toBe(0);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].payload).toEqual({ stripe_status: "canceled" });
    const f = Object.fromEntries(h.updates[0].filters as Filter[]);
    expect(f).toMatchObject({ id: ATTEMPT, studio_id: STUDIO, status: "failed", stripe_payment_intent_id: PI });
    expect(h.alerts).toContainEqual({ severity: "info", event: "session_payment_declined_intent_canceled" });
    expect(touchedReplacement()).toBe(false);
  });
  it("a duplicate or late payment_failed after the cancel changes nothing and cancels nothing again", async () => {
    h.rows[ATTEMPT] = { ...ROW, stripe_status: "canceled" };
    expect(await run()).toEqual({ outcome: "already_canceled" });
    expect(h.cancelIds).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(touchedReplacement()).toBe(false);
  });
  it("an intent Stripe already canceled is recorded without a second cancel", async () => {
    h.retrieveReply = pi({ status: "canceled" });
    expect(await run()).toEqual({ outcome: "canceled" });
    expect(h.cancelIds).toEqual([]);
    expect(h.updates[0].payload).toEqual({ stripe_status: "canceled" });
  });
  it("a late event for the old intent while a replacement is pending never touches the replacement", async () => {
    expect(await run()).toEqual({ outcome: "canceled" });
    expect(h.rows[REPLACEMENT]).toEqual(REPLACEMENT_ROW);
    expect(touchedReplacement()).toBe(false);
    // and an event naming the REPLACEMENT's intent against the old attempt is not applicable
    h.cancelIds = [];
    expect(await run({ eventPaymentIntentId: NEW_PI })).toEqual({ outcome: "not_applicable" });
    expect(h.cancelIds).toEqual([]);
  });
});

describe("verify first: anything unproven cancels nothing", () => {
  const refused = async (reason: string) => {
    const r = await run();
    expect(r).toEqual({ outcome: "refused", reason });
    expect(h.cancelIds).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.alerts).toContainEqual({ severity: "critical", event: "session_payment_decline_cleanup_refused" });
  };
  for (const status of ["succeeded", "processing", "requires_action", "requires_capture", "requires_confirmation"]) {
    it(`an intent that is ${status} is NOT cancelled`, async () => {
      h.retrieveReply = pi({ status });
      await refused("not_awaiting_method");
    });
  }
  it("wrong metadata attempt id refuses", async () => {
    h.retrieveReply = pi({ metadata: { hone_session_payment_charge_attempt_id: REPLACEMENT } });
    await refused("identity_mismatch");
  });
  it("the canonical key alone is accepted, and a conflicting second key refuses", async () => {
    h.retrieveReply = pi({ metadata: { hone_payment_charge_attempt_id: ATTEMPT } });
    expect((await run()).outcome).toBe("canceled");
    h.rows[ATTEMPT] = { ...ROW };
    h.cancelIds = [];
    h.updates = [];
    h.alerts = [];
    h.retrieveReply = pi({ metadata: { hone_payment_charge_attempt_id: ATTEMPT, hone_session_payment_charge_attempt_id: REPLACEMENT } });
    await refused("identity_mismatch");
  });
  it("missing metadata refuses", async () => {
    h.retrieveReply = pi({ metadata: {} });
    await refused("identity_mismatch");
  });
  it("a different id returned by Stripe refuses", async () => {
    h.retrieveReply = pi({ id: "pi_other" });
    await refused("identity_mismatch");
  });
  it("wrong amount, currency or mode refuses", async () => {
    h.retrieveReply = pi({ amount: 1 });
    await refused("identity_mismatch");
    h.alerts = [];
    h.retrieveReply = pi({ currency: "usd" });
    await refused("identity_mismatch");
    h.alerts = [];
    h.retrieveReply = pi({ livemode: true });
    await refused("identity_mismatch");
  });
  it("anything received refuses", async () => {
    h.retrieveReply = pi({ amount_received: 100 });
    await refused("amount_received");
  });
  it("a cancel response that is not a confirmed cancel refuses and writes nothing", async () => {
    h.cancelReply = pi({ status: "requires_payment_method" });
    const r = await run();
    expect(r).toMatchObject({ outcome: "retry" });
    expect(h.updates).toEqual([]);
  });
  const notApplicable: Array<[string, Record<string, unknown>]> = [
    ["a stored intent that is not the event's", { stripe_payment_intent_id: "pi_other" }],
    ["no stored intent", { stripe_payment_intent_id: null }],
    ["a fee attempt (owner-only close stays separate)", { charge_reason: "no_show_fee" }],
    ["a row that is not failed", { status: "pending_stripe" }],
    ["a row that is succeeded", { status: "succeeded" }],
    ["a charged row", { charged_at: "2026-11-19T00:00:00Z" }],
    ["a row with a charge id", { stripe_charge_id: "ch_1" }],
    ["a live-mode row in test mode", { stripe_livemode: true }],
    ["no connected account", { stripe_account_id: null }],
  ];
  for (const [name, over] of notApplicable) {
    it(`${name}: nothing to clean up, no Stripe call`, async () => {
      h.rows[ATTEMPT] = { ...ROW, ...over };
      expect(await run()).toEqual({ outcome: "not_applicable" });
      expect(h.retrieveIds).toEqual([]);
      expect(h.cancelIds).toEqual([]);
      expect(h.updates).toEqual([]);
    });
  }
  it("a missing attempt, or another studio's, is not applicable", async () => {
    h.rows = {};
    expect(await run()).toEqual({ outcome: "not_applicable" });
  });
});

describe("retry only the cancel, bounded, with an alert on final failure", () => {
  it("a failed cancel asks for a retry, writes nothing, never writes failed, never creates", async () => {
    h.cancelError = new Error("network");
    const r = await run();
    expect(r).toEqual({ outcome: "retry", reason: "cancel_not_confirmed" });
    expect(h.updates).toEqual([]);
    expect(h.creates).toBe(0);
    expect(h.alerts).toContainEqual({ severity: "warning", event: "session_payment_decline_cleanup_retrying" });
  });
  it("a failed retrieve asks for a retry and cancels nothing", async () => {
    h.retrieveError = new Error("network");
    expect(await run()).toEqual({ outcome: "retry", reason: "retrieve_failed" });
    expect(h.cancelIds).toEqual([]);
  });
  it("the redelivery after a failure runs only the cancel and then completes", async () => {
    h.cancelError = new Error("network");
    expect((await run()).outcome).toBe("retry");
    h.cancelError = null;
    expect(await run()).toEqual({ outcome: "canceled" });
    expect(h.cancelIds).toEqual([PI, PI]);
    expect(h.updates.every((u) => Object.keys(u.payload).join() === "stripe_status")).toBe(true);
    expect(touchedReplacement()).toBe(false);
  });
  it("a cancel that worked but whose stored fact could not be written retries, and the redelivery records it without a second cancel", async () => {
    h.updateRows = [];
    expect(await run()).toEqual({ outcome: "retry", reason: "persist_failed" });
    h.updateRows = [{ id: "x" }];
    h.retrieveReply = pi({ status: "canceled" });
    expect(await run()).toEqual({ outcome: "canceled" });
    expect(h.cancelIds).toEqual([PI]);
  });
  it("past the retry window it stops, with a critical alert, instead of retrying forever", async () => {
    h.cancelError = new Error("network");
    const r = await run({ eventCreatedSeconds: (NOW - CLEANUP_RETRY_WINDOW_MS - 1000) / 1000 });
    expect(r).toEqual({ outcome: "gave_up", reason: "cancel_not_confirmed" });
    expect(h.alerts).toContainEqual({ severity: "critical", event: "session_payment_decline_cleanup_gave_up" });
  });
  it("an attempt read error asks for a retry and touches nothing", async () => {
    h.readError = { code: "XX000" };
    expect(await run()).toEqual({ outcome: "retry", reason: "attempt_read_failed" });
    expect(h.retrieveIds).toEqual([]);
    expect(h.alerts).toContainEqual({ severity: "warning", event: "session_payment_decline_cleanup_retrying" });
  });
  it("an attempt read error is bounded like every other retry: past the window it stops with the critical alert", async () => {
    h.readError = { code: "XX000" };
    const r = await run({ eventCreatedSeconds: (NOW - CLEANUP_RETRY_WINDOW_MS - 1000) / 1000 });
    expect(r).toEqual({ outcome: "gave_up", reason: "attempt_read_failed" });
    expect(h.alerts).toContainEqual({ severity: "critical", event: "session_payment_decline_cleanup_gave_up" });
    expect(h.retrieveIds).toEqual([]);
  });
});

describe("the reasons survive the alert redactor", () => {
  // Found on the browser lane: a reason of 32 or more token characters is treated as a secret-shaped value and stored as
  // "[redacted]", which left an operator with no reason. Every reason string the helper can emit must come back unchanged.
  it("every reason literal passes redactOpsAlertDetails unchanged", async () => {
    const { redactOpsAlertDetails } = await import("@/lib/ops/redact");
    const src = readFileSync(path.join(__dirname, "../../..", "lib/billing/cancel-declined-session-intent.ts"), "utf8");
    const reasons = [...src.matchAll(/\b(?:refuse|failed)\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(8);
    for (const reason of reasons) {
      expect(redactOpsAlertDetails({ attempt_id: ATTEMPT, reason }), reason).toEqual({ attempt_id: ATTEMPT, reason });
    }
  });
});

describe("source shape: where the cleanup is wired", () => {
  const root = path.join(__dirname, "../../..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  const webhook = read("lib/billing/payment-webhook-reconciliation.ts");
  const helper = read("lib/billing/cancel-declined-session-intent.ts");
  it("runs after the failed write and on an already-failed redelivery, only for a verified card decline", () => {
    expect(webhook).toMatch(/closeDeclinedOriginalIntent\(event, attempt, pi\)/g);
    expect((webhook.match(/closeDeclinedOriginalIntent\(event, attempt, pi\)/g) ?? []).length).toBe(2);
    expect(webhook).toMatch(/pi\.status !== "requires_payment_method" \|\| pi\.last_payment_error\?\.type !== "card_error"\) return \{\}/);
    expect(webhook).toMatch(/if \(result\.outcome === "retry"\) throw new PaymentDeclineCleanupRetryError\(\)/);
  });
  it("the helper reuses the single cancel site, never creates or writes failed, and only updates stripe_status", () => {
    expect(helper).toContain("cancelPaymentIntentConfirmed(");
    expect(helper).not.toMatch(/paymentIntents\.(create|cancel)\(/);
    expect(helper).not.toMatch(/status: "failed"\s*[,}]/);
    expect((helper.match(/\.update\(/g) ?? []).length).toBe(1);
    expect(helper).toContain('.update({ stripe_status: "canceled" })');
  });
});

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe/server", () => ({ getStripe: () => ({}) }));
const { refundListDescribesCharge, payloadHasCompleteRefundList, chargeWithRefundList } = await import("@/lib/billing/charge-refund-list");

// HON-49: the authenticated refund-list read. The route-level behaviour (paging, retry, refusal) is proved in webhook-durable-account-read.test.ts;
// this file holds the pure rules and the source guards.

const charge = (over: Record<string, unknown> = {}) => ({ id: "ch_1", amount: 5000, currency: "cad", payment_intent: "pi_1", amount_refunded: 2000, ...over }) as unknown as Stripe.Charge;
const refund = (id: string, amount: number, status = "succeeded", over: Record<string, unknown> = {}) =>
  ({ object: "refund", id, amount, currency: "cad", charge: "ch_1", payment_intent: "pi_1", status, ...over }) as unknown as Stripe.Refund;

describe("refundListDescribesCharge: accept ahead, refuse behind", () => {
  it("accepts a list that accounts for the signed total, exactly or ahead of it", () => {
    expect(refundListDescribesCharge(charge(), [refund("re_1", 2000)])).toBe(true);
    expect(refundListDescribesCharge(charge(), [refund("re_1", 2000), refund("re_2", 1000)])).toBe(true); // ahead: a later refund
    expect(refundListDescribesCharge(charge({ amount_refunded: 2000 }), [refund("re_1", 1000), refund("re_2", 1000, "pending")])).toBe(true);
  });
  it("refuses a list BEHIND the signed total (a refund the charge counts is missing)", () => {
    expect(refundListDescribesCharge(charge({ amount_refunded: 3000 }), [refund("re_1", 2000)])).toBe(false);
    expect(refundListDescribesCharge(charge({ amount_refunded: 2000 }), [refund("re_1", 2000, "failed")])).toBe(false);
  });
  it("refuses an empty list, a repeated id, and a refund of another charge, payment intent or currency", () => {
    expect(refundListDescribesCharge(charge(), [])).toBe(false);
    expect(refundListDescribesCharge(charge(), [refund("re_1", 1000), refund("re_1", 1000)])).toBe(false);
    expect(refundListDescribesCharge(charge(), [refund("re_1", 2000, "succeeded", { charge: "ch_x" })])).toBe(false);
    expect(refundListDescribesCharge(charge(), [refund("re_1", 2000, "succeeded", { payment_intent: "pi_x" })])).toBe(false);
    expect(refundListDescribesCharge(charge(), [refund("re_1", 2000, "succeeded", { currency: "usd" })])).toBe(false);
  });
  it("reads an expanded charge or payment intent by its id", () => {
    expect(refundListDescribesCharge(charge(), [refund("re_1", 2000, "succeeded", { charge: { id: "ch_1" }, payment_intent: { id: "pi_1" } })])).toBe(true);
  });
});

describe("payloadHasCompleteRefundList", () => {
  it("absent, null, empty and cut-short lists need the read; a list with refunds does not", () => {
    expect(payloadHasCompleteRefundList(charge())).toBe(false);
    expect(payloadHasCompleteRefundList(charge({ refunds: null }))).toBe(false);
    expect(payloadHasCompleteRefundList(charge({ refunds: { object: "list", data: [], has_more: false } }))).toBe(false);
    expect(payloadHasCompleteRefundList(charge({ refunds: { object: "list", data: [refund("re_1", 1)], has_more: true } }))).toBe(false);
    expect(payloadHasCompleteRefundList(charge({ refunds: { object: "list", data: [refund("re_1", 1)], has_more: false } }))).toBe(true);
  });
  it("chargeWithRefundList keeps every signed field and replaces only the list", () => {
    const c = charge({ customer: "cus_1" });
    const w = chargeWithRefundList(c, [refund("re_1", 2000)]);
    expect(w).toMatchObject({ id: "ch_1", customer: "cus_1", amount: 5000, amount_refunded: 2000, refunds: { has_more: false } });
  });
});

describe("source guards", () => {
  const code = (p: string) => readFileSync(p, "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  const MOD = code("lib/billing/charge-refund-list.ts");
  it("the read takes ONLY the signed event's charge id and connected account, and names no stored attempt field", () => {
    expect(MOD).toMatch(/readCompleteChargeRefundList\(args: \{ chargeId: string; stripeAccount: string \}\)/);
    expect(MOD).not.toMatch(/attempt|stripe_charge_id|stripe_customer_id|stripe_payment_intent_id|stripe_account_id/i);
  });
  it("the read is scoped to the connected account and is a list (read-only); no create, update or cancel call exists in the module", () => {
    expect(MOD).toMatch(/refunds\.list\(/);
    expect(MOD).toMatch(/\{ stripeAccount, timeout: REFUND_LIST_REQUEST_TIMEOUT_MS \}/);
    expect(MOD).not.toMatch(/\.(create|update|cancel)\(/);
  });
  it("the page cap, page size and timeout are named constants with a stated bound", () => {
    expect(MOD).toMatch(/export const REFUND_LIST_PAGE_SIZE = 100;/);
    expect(MOD).toMatch(/export const REFUND_LIST_MAX_PAGES = 5;/);
    expect(MOD).toMatch(/export const REFUND_LIST_REQUEST_TIMEOUT_MS = 8000;/);
    expect(MOD).toMatch(/page < REFUND_LIST_MAX_PAGES/);
  });
  it("no other file reads refunds from the provider with refunds.list, and only the webhook reconciler imports the module", () => {
    const hits = execSync(`git grep -l "refunds\\.list(" -- lib app components ':!lib/billing/charge-refund-list.ts' || true`, { encoding: "utf8" }).trim();
    expect(hits).toBe("");
    const importers = execSync(`git grep -l "billing/charge-refund-list" -- lib app components || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    expect(importers).toEqual(["lib/billing/payment-webhook-reconciliation.ts"]);
  });
  it("the reconciler still does not import getStripe itself; its read goes only through the module, after the money check and before any write", () => {
    const hook = readFileSync("lib/billing/payment-webhook-reconciliation.ts", "utf8");
    expect(hook).not.toMatch(/import \{[^}]*getStripe/);
    const body = hook.slice(hook.indexOf("export async function handleChargeRefunded"));
    const money = body.indexOf("verifyProviderMoneyAgainstRow");
    const read = body.indexOf("readCompleteChargeRefundList(");
    const write = body.indexOf("recordChargeRefundHistory(refundEvent");
    expect(money).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(money);
    expect(write).toBeGreaterThan(read);
    expect(body).toMatch(/readCompleteChargeRefundList\(\{ chargeId: charge\.id, stripeAccount: ctx\.stripeAccountId \?\? "" \}\)/);
  });
});

// One provider account belongs to exactly one studio. The refund read and every lookup trust this: an event's connected account resolves to ONE studio.
describe("one provider account, one studio (schema)", () => {
  const sql = readFileSync("supabase/migrations/0032_stripe_connect_phase_1.sql", "utf8");
  it("studio_payment_settings: studio_id is the primary key and stripe_account_id is UNIQUE", () => {
    const table = sql.slice(sql.indexOf("create table public.studio_payment_settings"));
    expect(table).toMatch(/studio_id\s+uuid primary key references public\.studios\(id\)/);
    expect(table.slice(0, 600)).toMatch(/stripe_account_id\s+text unique/);
  });
  it("payment rows are tied to that identity root by a composite foreign key (studio, account, mode)", () => {
    expect(sql).toMatch(/foreign key \(studio_id, stripe_account_id, stripe_livemode\)\s+references public\.studio_payment_settings \(studio_id, stripe_account_id, stripe_livemode\)/);
  });
});

// The fake provider is reachable from this read ONLY through the one existing client seam, and the real client is the default.
describe("the fake provider is chosen only through the existing client seam", () => {
  const src = readFileSync("lib/billing/charge-refund-list.ts", "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  it("takes its client only from getSessionPaymentStripe(): it never names the fake, the guard, the flag, the environment or getStripe itself", () => {
    expect(src).toMatch(/const stripe = getSessionPaymentStripe\(\)/);
    expect(src).not.toMatch(/createFakeStripe|isE2eFakeStripeEnabled|assertFakeStripeNotRequestedInDeployment|getStripe\b/);
    expect(src).not.toMatch(/HONE_E2E_/);
    expect(src).not.toMatch(/process\.env/);
  });
  it("the seam fails loud when the fake flag is set in a deployment, before it picks the fake", () => {
    const seam = readFileSync("lib/stripe/session-payment-stripe.ts", "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(seam.indexOf("assertFakeStripeNotRequestedInDeployment()")).toBeGreaterThan(-1);
    expect(seam.indexOf("isE2eFakeStripeEnabled()")).toBeGreaterThan(seam.indexOf("assertFakeStripeNotRequestedInDeployment()"));
  });
  it("no other server code selects the fake client: only the seam and the fake itself (every tracked file outside tests, e2e and docs)", () => {
    const out = execSync(
      "git grep -l createFakeStripe -- . ':!tests' ':!e2e' ':!e2e-payment' ':!e2e-google' ':!e2e-mobile' ':!docs' ':!openwiki' || true",
      { encoding: "utf8" },
    ).split("\n").filter(Boolean).sort();
    expect(out).toEqual(["lib/stripe/e2e-fake-stripe.ts", "lib/stripe/session-payment-stripe.ts"]);
  });
});

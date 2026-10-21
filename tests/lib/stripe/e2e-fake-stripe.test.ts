import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setFakeStripeBehavior, cleanupFakeStripeFiles, readFakeStripeCalls } from "@/lib/stripe/e2e-fake-ledger";
import {
  assertE2eFakeStripeAllowed,
  assertFakeStripeNotRequestedInDeployment,
  isE2eFakeStripeEnabled,
  isValidE2eRunId,
} from "@/lib/stripe/e2e-fake-guard";
import {
  createFakeStripe,
  getFakeStripeCalls,
  resetFakeStripeState,
} from "@/lib/stripe/e2e-fake-stripe";

// Security proof for the server-only fake-Stripe activation boundary. The guard
// is a PURE env-evaluation function, so the matrix passes an env object and never
// mutates the real process environment. Fail-closed: fake mode is OFF unless the
// exact local-E2E shape is present, and impossible in any deployed runtime.

// The exact approved local-E2E shape (the Playwright server runs `next start`, so
// NODE_ENV=production — the guard intentionally does NOT gate on NODE_ENV; the
// positive HONE_E2E_* markers + the Vercel/deployment rejection are the boundary).
const LOCAL_E2E_ENV = {
  HONE_E2E_FAKE_STRIPE: "1",
  HONE_E2E_RUN_ID: "run-abcd1234",
  NODE_ENV: "production", // local `next start`
} as unknown as NodeJS.ProcessEnv;

describe("activation guard — ALLOWED only in the exact local-E2E shape", () => {
  it("allows fake mode with the flag + a valid run id + no deployment markers", () => {
    expect(() => assertE2eFakeStripeAllowed(LOCAL_E2E_ENV)).not.toThrow();
    expect(isE2eFakeStripeEnabled(LOCAL_E2E_ENV)).toBe(true);
  });
});

describe("activation guard — REJECTED matrix (fail-closed)", () => {
  const reject = (env: Record<string, string | undefined>) => {
    const e = env as unknown as NodeJS.ProcessEnv;
    expect(() => assertE2eFakeStripeAllowed(e)).toThrow();
    expect(isE2eFakeStripeEnabled(e)).toBe(false);
  };

  it("1. flag absent", () => reject({ HONE_E2E_RUN_ID: "run-abcd1234" }));
  it("2. flag not exactly '1'", () => {
    reject({ HONE_E2E_FAKE_STRIPE: "true", HONE_E2E_RUN_ID: "run-abcd1234" });
    reject({ HONE_E2E_FAKE_STRIPE: "0", HONE_E2E_RUN_ID: "run-abcd1234" });
    reject({ HONE_E2E_FAKE_STRIPE: "yes", HONE_E2E_RUN_ID: "run-abcd1234" });
  });
  it("3. run id absent", () => reject({ HONE_E2E_FAKE_STRIPE: "1" }));
  it("4. run id empty", () =>
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "" }));
  it("5. run id invalid chars / too long", () => {
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "bad id!" });
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "a".repeat(65) });
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "short" });
  });
  it("6. VERCEL=1", () =>
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "run-abcd1234", VERCEL: "1" }));
  it("7. VERCEL_ENV=production", () =>
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "run-abcd1234", VERCEL_ENV: "production" }));
  it("8. VERCEL_ENV=preview", () =>
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "run-abcd1234", VERCEL_ENV: "preview" }));
  it("9. VERCEL_ENV=development", () =>
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "run-abcd1234", VERCEL_ENV: "development" }));
  it("10. AWS deployment marker", () =>
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "run-abcd1234", AWS_REGION: "us-east-1" }));
  it("11. Kubernetes deployment marker", () =>
    reject({ HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: "run-abcd1234", KUBERNETES_SERVICE_HOST: "10.0.0.1" }));
  it("12. only a browser-visible variable set (flag absent → rejected)", () =>
    reject({ NEXT_PUBLIC_FAKE_STRIPE: "1" }));
  it("does not leak env values in the thrown message", () => {
    try {
      assertE2eFakeStripeAllowed({
        HONE_E2E_FAKE_STRIPE: "1",
        HONE_E2E_RUN_ID: "run-abcd1234",
        VERCEL_ENV: "production",
      } as unknown as NodeJS.ProcessEnv);
    } catch (e) {
      // The VERCEL_ENV label is fine; no secret/token is echoed.
      expect(String(e)).not.toMatch(/sk_(test|live)_|whsec_|SUPABASE|SERVICE_ROLE/);
    }
  });
});

describe("isValidE2eRunId", () => {
  it("accepts a well-formed token, rejects malformed", () => {
    expect(isValidE2eRunId("run-abcd1234")).toBe(true);
    expect(isValidE2eRunId(undefined)).toBe(false);
    expect(isValidE2eRunId("")).toBe(false);
    expect(isValidE2eRunId("has space")).toBe(false);
    expect(isValidE2eRunId("a".repeat(65))).toBe(false);
    expect(isValidE2eRunId("bad!id")).toBe(false);
  });
});

describe("fail-LOUD deployment guard", () => {
  it("throws when the flag is set in a Vercel/deployed environment", () => {
    for (const dep of [
      { VERCEL: "1" },
      { VERCEL_ENV: "production" },
      { VERCEL_ENV: "preview" },
      { AWS_REGION: "us-east-1" },
    ]) {
      expect(() =>
        assertFakeStripeNotRequestedInDeployment({
          HONE_E2E_FAKE_STRIPE: "1",
          ...dep,
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow(/never be set in a deployed environment/);
    }
  });
  it("is a no-op when the flag is absent (production path unchanged)", () => {
    expect(() =>
      assertFakeStripeNotRequestedInDeployment({
        VERCEL: "1",
        VERCEL_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
  it("is a no-op in the local shape (flag set, no deployment markers)", () => {
    expect(() =>
      assertFakeStripeNotRequestedInDeployment(LOCAL_E2E_ENV),
    ).not.toThrow();
  });
});

describe("exposure / dependency guards (no browser or request control)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const GUARD = read("lib/stripe/e2e-fake-guard.ts");
  const FAKE = read("lib/stripe/e2e-fake-stripe.ts");
  const SEAM = read("lib/stripe/session-payment-stripe.ts");

  it("guard + fake + seam are server-only modules", () => {
    for (const src of [GUARD, FAKE, SEAM]) {
      expect(src.trimStart().startsWith('import "server-only"')).toBe(true);
    }
  });
  it("uses only server-only env markers — never a NEXT_PUBLIC_* control", () => {
    for (const src of [GUARD, FAKE, SEAM]) {
      expect(src).not.toMatch(/NEXT_PUBLIC_[A-Z_]*FAKE/);
      expect(src).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
    }
    expect(GUARD).toMatch(/HONE_E2E_FAKE_STRIPE/);
    expect(GUARD).toMatch(/HONE_E2E_RUN_ID/);
  });
  it("selects the processor from env only — no request header/cookie/query/form", () => {
    for (const src of [GUARD, FAKE, SEAM]) {
      expect(src).not.toMatch(/headers\(\)|cookies\(\)|searchParams|nextUrl|req\.headers|formData/);
    }
  });
  it("no NEXT_PUBLIC_* variable is READ to control fake mode", () => {
    // The guard may DOCUMENT that it avoids NEXT_PUBLIC_*, but must never read one.
    for (const src of [GUARD, FAKE, SEAM]) {
      expect(src).not.toMatch(/env\.NEXT_PUBLIC_/);
    }
  });
  it("no route or client component reads HONE_E2E_FAKE_STRIPE (only the guard does)", () => {
    // The seam/fake reach the flag ONLY through the guard module's functions.
    expect(SEAM).not.toMatch(/HONE_E2E_FAKE_STRIPE/);
    expect(FAKE).not.toMatch(/HONE_E2E_FAKE_STRIPE/);
    expect(SEAM).toMatch(/isE2eFakeStripeEnabled|assertFakeStripeNotRequestedInDeployment/);
  });
  it("the fake unit tests require no real Stripe secret", () => {
    // This suite constructs the fake + guard purely from env objects; no
    // STRIPE_SECRET_KEY is read. (Sanity: the fake module never reads it.)
    expect(FAKE).not.toMatch(/STRIPE_SECRET_KEY/);
  });
});

describe("production-path invariance (seam)", () => {
  const SEAM = readFileSync(
    join(process.cwd(), "lib/stripe/session-payment-stripe.ts"),
    "utf8",
  );
  it("returns the REAL getStripe() by default; the fake only after the guard passes", () => {
    expect(SEAM).toMatch(/if \(isE2eFakeStripeEnabled\(\)\) \{\s*return createFakeStripe\(\);/);
    expect(SEAM).toMatch(/const stripe = getStripe\(\);\s*return stripe;/);
  });
  it("calls the fail-loud deployment guard before any fake branch", () => {
    expect(SEAM.indexOf("assertFakeStripeNotRequestedInDeployment")).toBeLessThan(
      SEAM.indexOf("createFakeStripe()"),
    );
  });
});

describe("fake-call recorder — invocation vs effect, run-isolated, test-safe", () => {
  const RUN = "run-testABC123";
  const prev = process.env.HONE_E2E_RUN_ID;
  afterEach(() => {
    resetFakeStripeState(RUN);
    resetFakeStripeState("run-otherXYZ");
    if (prev === undefined) delete process.env.HONE_E2E_RUN_ID;
    else process.env.HONE_E2E_RUN_ID = prev;
  });

  // Invocation = every pi_create call; effect = a create that produced a NEW
  // result for a previously-unseen idempotency key (replay=false).
  const invocations = (run: string) =>
    getFakeStripeCalls(run).filter((c) => c.method === "pi_create");
  const effects = (run: string) =>
    getFakeStripeCalls(run).filter((c) => c.method === "pi_create" && !c.replay);

  it("first call: invocation 1, effect 1, replay false + captures key/account/id", async () => {
    process.env.HONE_E2E_RUN_ID = RUN;
    const stripe = createFakeStripe();
    const pi = await (stripe.paymentIntents.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ id: string; status: string }>)(
      { amount: 22500, currency: "cad", confirm: true },
      { stripeAccount: "acct_test_123", idempotencyKey: "hone:session_payment:att1:v1" },
    );
    expect(pi.id).toMatch(/^pi_test_e2e_/);
    expect(pi.status).toBe("succeeded");
    expect(invocations(RUN)).toHaveLength(1);
    expect(effects(RUN)).toHaveLength(1);
    expect(invocations(RUN)[0]).toMatchObject({
      method: "pi_create",
      idempotencyKey: "hone:session_payment:att1:v1",
      stripeAccount: "acct_test_123",
      amountCents: 22500,
      currency: "cad",
      replay: false,
    });
  });

  it("same idempotency key again: invocation 2, effect stays 1, 2nd is replay + same id", async () => {
    process.env.HONE_E2E_RUN_ID = RUN;
    const stripe = createFakeStripe();
    const create = stripe.paymentIntents.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ id: string }>;
    const a = await create({ amount: 100, currency: "cad" }, { idempotencyKey: "k1" });
    const b = await create({ amount: 100, currency: "cad" }, { idempotencyKey: "k1" });
    expect(a.id).toBe(b.id); // idempotent: same synthetic result
    // The replay is NOT hidden: two invocations recorded, only one effect.
    expect(invocations(RUN)).toHaveLength(2);
    expect(effects(RUN)).toHaveLength(1);
    expect(invocations(RUN)[0].replay).toBe(false);
    expect(invocations(RUN)[1].replay).toBe(true);
    expect(invocations(RUN)[1].resultId).toBe(a.id);
  });

  it("different idempotency key: invocation AND effect both increase", async () => {
    process.env.HONE_E2E_RUN_ID = RUN;
    const stripe = createFakeStripe();
    const create = stripe.paymentIntents.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ id: string }>;
    const a = await create({ amount: 100, currency: "cad" }, { idempotencyKey: "k1" });
    const b = await create({ amount: 100, currency: "cad" }, { idempotencyKey: "k2" });
    expect(a.id).not.toBe(b.id);
    expect(invocations(RUN)).toHaveLength(2);
    expect(effects(RUN)).toHaveLength(2);
  });

  it("isolates calls by run id — one run cannot read another run's calls", async () => {
    process.env.HONE_E2E_RUN_ID = RUN;
    const s1 = createFakeStripe();
    await (s1.paymentIntents.create as unknown as (p: unknown, o: unknown) => Promise<unknown>)(
      { amount: 100, currency: "cad" },
      { idempotencyKey: "a" },
    );
    process.env.HONE_E2E_RUN_ID = "run-otherXYZ";
    const s2 = createFakeStripe();
    await (s2.paymentIntents.create as unknown as (p: unknown, o: unknown) => Promise<unknown>)(
      { amount: 200, currency: "cad" },
      { idempotencyKey: "b" },
    );
    expect(getFakeStripeCalls(RUN)).toHaveLength(1);
    expect(getFakeStripeCalls("run-otherXYZ")).toHaveLength(1);
    expect(getFakeStripeCalls(RUN)[0].resultId).not.toBe(
      getFakeStripeCalls("run-otherXYZ")[0].resultId,
    );
  });

  it("reset only clears the requested run", async () => {
    process.env.HONE_E2E_RUN_ID = RUN;
    const s = createFakeStripe();
    await (s.paymentIntents.create as unknown as (p: unknown, o: unknown) => Promise<unknown>)(
      { amount: 1, currency: "cad" },
      { idempotencyKey: "x" },
    );
    resetFakeStripeState(RUN);
    expect(getFakeStripeCalls(RUN)).toHaveLength(0);
  });

  it("the recorded shape carries no client/email/card/PHI fields", () => {
    // The recorder type is method/key/account/amount/currency/resultId/replay only.
    const keys = ["method", "idempotencyKey", "stripeAccount", "amountCents", "currency", "resultId", "replay"];
    const src = readFileSync(join(process.cwd(), "lib/stripe/e2e-fake-stripe.ts"), "utf8");
    for (const forbidden of ["email", "last4", "customer", "client_id", "card_", "signature", "cvc", "secret"]) {
      // no forbidden field is recorded (the FakeStripeCall type block)
      const typeBlock = src.slice(src.indexOf("export type FakeStripeCall"), src.indexOf("};", src.indexOf("export type FakeStripeCall")));
      expect(typeBlock.toLowerCase()).not.toContain(forbidden);
    }
    expect(keys.length).toBe(7);
  });
});


describe("staged fake original create / confirmation contract", () => {
  const RUN = "run-staged-hyphen-123";
  const OTHER = "run-staged-other-123";
  const savedEnv = { ...process.env };
  const account = "acct_test_staged";
  const createKey = "hone:session_payment:attempt-unit:v2:create";
  const opts = { stripeAccount: account, idempotencyKey: createKey };
  const params = { amount: 15000, currency: "usd", customer: "cus_private_fixture",
    payment_method: "pm_private_fixture", confirm: false, confirmation_method: "manual" as const };
  const confirmOpts = (id: string) => ({ stripeAccount: account,
    idempotencyKey: `hone:session_payment:attempt-unit:v2:confirm:${id}` });
  beforeEach(() => {
    process.env = { ...savedEnv, HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: RUN };
    for (const key of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"]) delete process.env[key];
    resetFakeStripeState(RUN); resetFakeStripeState(OTHER);
    cleanupFakeStripeFiles(RUN); cleanupFakeStripeFiles(OTHER);
  });
  afterEach(() => {
    cleanupFakeStripeFiles(RUN); cleanupFakeStripeFiles(OTHER);
    resetFakeStripeState(RUN); resetFakeStripeState(OTHER);
    process.env = { ...savedEnv };
  });
  it("creates a complete unconfirmed original, not a successful money charge", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    expect(pi).toMatchObject({ status: "requires_confirmation", confirmation_method: "manual",
      customer: params.customer, payment_method: params.payment_method, livemode: false,
      amount: 15000, currency: "usd", latest_charge: null, amount_received: 0, amount_capturable: 0 });
    expect(pi.id).toMatch(/^pi_[A-Za-z0-9_]+$/); // hyphenated run IDs remain valid synthetic PI IDs
    expect(getFakeStripeCalls()).toMatchObject([{ method: "pi_create", replay: false }]);
    expect(getFakeStripeCalls().filter(c => c.method === "pi_confirm")).toEqual([]);
    expect(await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).toMatchObject({ status: "requires_confirmation", latest_charge: null });
  });
  it("only confirmation produces the succeeded original and charge facts", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    const paid = await stripe.paymentIntents.confirm(pi.id, { off_session: true }, confirmOpts(pi.id));
    expect(paid).toMatchObject({ id: pi.id, status: "succeeded", amount: 15000, currency: "usd",
      customer: params.customer, payment_method: params.payment_method, livemode: false, amount_received: 15000 });
    expect(paid.latest_charge).toMatch(/^ch_test_e2e_/);
    expect(await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).toMatchObject({ id: pi.id, status: "succeeded", latest_charge: paid.latest_charge });
    expect(getFakeStripeCalls().filter(c => c.method === "pi_confirm")).toHaveLength(1);
  });
  it("records both confirmation invocations while idempotency preserves one outcome", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    const [a, b] = await Promise.all([stripe.paymentIntents.confirm(pi.id, { off_session: true }, confirmOpts(pi.id)),
      stripe.paymentIntents.confirm(pi.id, { off_session: true }, confirmOpts(pi.id))]);
    expect(a).toEqual(b);
    expect(getFakeStripeCalls().filter(c => c.method === "pi_confirm").map(c => c.replay)).toEqual([false, true]);
    await expect(stripe.paymentIntents.confirm(pi.id, { off_session: true }, { stripeAccount: account, idempotencyKey: "different-key" })).rejects.toThrow();
    expect((await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).latest_charge).toBe(a.latest_charge);
  });
  it("create replay retains the original unconfirmed response while retrieval sees current state", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    await stripe.paymentIntents.confirm(pi.id, {}, confirmOpts(pi.id));
    expect(await stripe.paymentIntents.create(params, opts)).toMatchObject({ id: pi.id, status: "requires_confirmation", latest_charge: null });
    expect(await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).toMatchObject({ status: "succeeded" });
    expect(getFakeStripeCalls().filter(c => c.method === "pi_create").map(c => c.replay)).toEqual([false, true]);
  });
  it("scopes identical keys independently by account, method and original path", async () => {
    const stripe = createFakeStripe(); const same = { stripeAccount: account, idempotencyKey: "same" };
    const a = await stripe.paymentIntents.create(params, same);
    const b = await stripe.paymentIntents.create(params, { ...same, stripeAccount: "acct_other" });
    expect(a.id).not.toBe(b.id);
    const paid = await stripe.paymentIntents.confirm(a.id, {}, same);
    const other = await stripe.paymentIntents.create(params, { ...same, idempotencyKey: "other-original" });
    const paidOther = await stripe.paymentIntents.confirm(other.id, {}, same);
    expect(paid.latest_charge).not.toBe(paidOther.latest_charge);
    if (typeof paid.latest_charge !== "string") throw new Error("Expected synthetic charge");
    const refunded = await stripe.refunds.create({ charge: paid.latest_charge, amount: 15000 }, same);
    expect(refunded.id).toMatch(/^re_test_e2e_/); expect(refunded.currency).toBe("usd");
  });
  it("refuses wrong-account and cross-run confirmation without changing the original", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    await expect(stripe.paymentIntents.confirm(pi.id, {}, { stripeAccount: "acct_other", idempotencyKey: "bad" })).rejects.toThrow();
    expect(await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).toMatchObject({ status: "requires_confirmation", latest_charge: null });
    process.env.HONE_E2E_RUN_ID = OTHER;
    await expect(stripe.paymentIntents.confirm(pi.id, {}, confirmOpts(pi.id))).rejects.toThrow();
    expect(getFakeStripeCalls(OTHER)).toMatchObject([{ method: "pi_confirm", replay: false }]);
  });
  it("refuses changed parameters under an existing operation key", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    await expect(stripe.paymentIntents.create({ ...params, amount: 15001 }, opts)).rejects.toThrow(/parameters differ/);
    const paid = await stripe.paymentIntents.confirm(pi.id, { off_session: true }, confirmOpts(pi.id));
    await expect(stripe.paymentIntents.confirm(pi.id, { off_session: false }, confirmOpts(pi.id))).rejects.toThrow(/parameters differ/);
    expect((await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).latest_charge).toBe(paid.latest_charge);
    expect(getFakeStripeCalls().filter(c => c.method === "pi_confirm").map(c => c.replay)).toEqual([false, true]);
  });
  it("keeps server-configured decline at confirmation and never fabricates a successful retrieval", async () => {
    setFakeStripeBehavior(RUN, createKey, "decline");
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    expect(pi.status).toBe("requires_confirmation");
    const result = await stripe.paymentIntents.confirm(pi.id, {}, confirmOpts(pi.id));
    expect(result).toMatchObject({ status: "requires_payment_method", latest_charge: null, amount_received: 0,
      last_payment_error: { type: "card_error", code: "card_declined" } });
    expect(await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).toMatchObject({ status: "requires_payment_method", latest_charge: null });
  });
  it("processing stays unresolved until an explicit server-side success observation", async () => {
    setFakeStripeBehavior(RUN, createKey, "processing");
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    expect(await stripe.paymentIntents.confirm(pi.id, {}, confirmOpts(pi.id))).toMatchObject({ status: "processing", latest_charge: null });
    expect(await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).toMatchObject({ status: "processing", latest_charge: null });
    setFakeStripeBehavior(RUN, createKey, "success");
    expect(await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).toMatchObject({ status: "succeeded", amount: 15000, currency: "usd" });
    expect(getFakeStripeCalls().filter(c => c.method === "pi_confirm")).toHaveLength(1);
  });
  it("refunds retain charge currency and exact idempotent amount with account refusal", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    const paid = await stripe.paymentIntents.confirm(pi.id, {}, confirmOpts(pi.id));
    if (typeof paid.latest_charge !== "string") throw new Error("Expected synthetic charge");
    const request = { charge: paid.latest_charge, amount: 500, currency: "cad" };
    const refundOptions = { stripeAccount: account, idempotencyKey: "refund" };
    const a = await stripe.refunds.create(request, refundOptions); const b = await stripe.refunds.create(request, refundOptions);
    expect(a).toMatchObject({ amount: 500, currency: "usd" }); expect(b).toEqual(a);
    expect(getFakeStripeCalls().filter(c => c.method === "refund_create").map(c => c.replay)).toEqual([false, true]);
    await expect(stripe.refunds.create(request, { ...refundOptions, stripeAccount: "acct_other" })).rejects.toThrow();
  });
  it("cancellation retains the known original and prevents later confirmation", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create(params, opts);
    expect(await stripe.paymentIntents.cancel(pi.id, {}, { stripeAccount: account })).toMatchObject({ id: pi.id, status: "canceled", amount: 15000, currency: "usd" });
    await expect(stripe.paymentIntents.confirm(pi.id, {}, confirmOpts(pi.id))).rejects.toThrow();
    expect(await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })).toMatchObject({ status: "canceled", latest_charge: null });
  });
  it("never persists customer, payment method, signature or description in call records", async () => {
    const stripe = createFakeStripe(); const pi = await stripe.paymentIntents.create({ ...params,
      description: "synthetic-private-description", metadata: { signature: "synthetic-private-signature" } }, opts);
    await stripe.paymentIntents.confirm(pi.id, {}, confirmOpts(pi.id));
    const text = JSON.stringify([getFakeStripeCalls(), readFakeStripeCalls(RUN)]);
    for (const value of [params.customer, params.payment_method, "synthetic-private-description", "synthetic-private-signature"]) expect(text).not.toContain(value);
    expect(Object.keys(getFakeStripeCalls()[0]).sort()).toEqual(["method", "idempotencyKey", "stripeAccount", "amountCents", "currency", "resultId", "replay"].sort());
  });
  it("existing browser counters and selector measure confirmation instead of unconfirmed object creation", () => {
    const helper = readFileSync(join(process.cwd(), "e2e-payment/helpers/fake-stripe-ledger-e2e.ts"), "utf8");
    const counters = helper.slice(helper.indexOf("export function readFakeStripeInvocations"), helper.indexOf("export function countFakeStripeInvocations"));
    expect(counters).toContain('c.method === "pi_confirm"'); expect(counters).not.toContain('c.method === "pi_create"');
    expect(readFileSync(join(process.cwd(), "e2e-payment/helpers/payment-fixture.ts"), "utf8")).toContain('`hone:session_payment:${attemptId}:v2:create`');
  });
});

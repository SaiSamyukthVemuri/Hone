import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  fakeMetadataDigest,
  getFakeStripeCalls,
  resetFakeStripeState,
} from "@/lib/stripe/e2e-fake-stripe";
import { metadataDigest } from "@/e2e-payment/helpers/fake-stripe-metadata-digest";

const pairedWebhook = vi.hoisted(() => ({ row: {} as Record<string, unknown> }));
vi.mock("@/tests/db/helpers/harness", () => ({
  adminQuery: async (sql: string) => {
    expect(sql.trimStart()).toMatch(/^select /i);
    expect(sql).toContain("from public.payment_charge_attempts");
    return { rows: [pairedWebhook.row] };
  },
}));
vi.mock("@/e2e/helpers/local-env", () => ({
  E2E_APP_ORIGIN: "http://127.0.0.1:3000",
  E2E_WEB_SERVER_ENV: { STRIPE_WEBHOOK_SECRET: "whsec_synthetic_paired_unit_only" },
}));

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
    // The recorder type is method/key/account/amount/currency/resultId/chargeId/
    // metadataDigest/replay only. chargeId (PAY-CCY-09) is a synthetic provider
    // id; metadataDigest is a one-way hash, never the metadata values.
    const keys = ["method", "idempotencyKey", "stripeAccount", "amountCents", "currency", "resultId", "chargeId", "metadataDigest", "payerDigest", "replay"];
    const src = readFileSync(join(process.cwd(), "lib/stripe/e2e-fake-stripe.ts"), "utf8");
    for (const forbidden of ["email", "last4", "customer", "client_id", "card_", "signature", "cvc", "secret"]) {
      // no forbidden field is recorded (the FakeStripeCall type block)
      const typeBlock = src.slice(src.indexOf("export type FakeStripeCall"), src.indexOf("};", src.indexOf("export type FakeStripeCall")));
      expect(typeBlock.toLowerCase()).not.toContain(forbidden);
    }
    expect(keys.length).toBe(10);
  });
});

// PAY-CCY-09 (Codex P2 4265594520). The fake records WHAT METADATA THE CHARGE
// PATH SENT, as a digest, so a webhook test cannot manufacture correct metadata
// from the row when the charge path sent something else.
describe("fake create records a digest of the metadata it received", () => {
  const RUN = "run-mdigest0001";
  const SENT = {
    hone_studio_id: "studio-1",
    hone_client_id: "client-1-SECRETLIKE",
    hone_session_id: null,
    hone_appointment_id: "",
    hone_session_payment_charge_attempt_id: "att-1",
    hone_charge_reason: "session_payment",
    hone_card_authorization_signature_id: "sig-1",
    hone_environment: "test",
  };

  afterEach(() => resetFakeStripeState(RUN));

  async function create(metadata: Record<string, string | null>) {
    process.env.HONE_E2E_RUN_ID = RUN;
    const s = createFakeStripe();
    await (s.paymentIntents.create as unknown as (p: unknown, o: unknown) => Promise<unknown>)(
      { amount: 18500, currency: "usd", metadata },
      { idempotencyKey: `k-${Math.random()}` },
    );
    return getFakeStripeCalls(RUN).at(-1)!;
  }

  it("records the digest of what was SENT, and never the values", async () => {
    const c = await create(SENT);
    expect(c.metadataDigest).toBe(fakeMetadataDigest(SENT));
    expect(JSON.stringify(c)).not.toContain("client-1-SECRETLIKE");
    expect(JSON.stringify(c)).not.toContain("studio-1");
  });

  it("a wrong value sent by the charge path yields a DIFFERENT digest", async () => {
    const right = await create(SENT);
    const wrong = await create({ ...SENT, hone_studio_id: SENT.hone_client_id });
    expect(wrong.metadataDigest).not.toBe(right.metadataDigest);
  });

  it("the Playwright-side digest is the same function (null/empty dropped, order-free)", () => {
    const fromRow = {
      hone_environment: "test",
      hone_card_authorization_signature_id: "sig-1",
      hone_charge_reason: "session_payment",
      hone_session_payment_charge_attempt_id: "att-1",
      hone_appointment_id: "",
      hone_session_id: "",
      hone_client_id: "client-1-SECRETLIKE",
      hone_studio_id: "studio-1",
    };
    expect(metadataDigest(fromRow)).toBe(fakeMetadataDigest(SENT));
    for (const m of [SENT, {}, { a: "1" }, { b: "2", a: "1" }, { a: undefined }]) {
      expect(metadataDigest(m)).toBe(fakeMetadataDigest(m));
    }
    expect(metadataDigest(null)).toBeNull();
    expect(fakeMetadataDigest(undefined)).toBeNull();
    expect(metadataDigest({ ...fromRow, hone_studio_id: "client-1-SECRETLIKE" })).not.toBe(
      fakeMetadataDigest(SENT),
    );
  });
});

// PAY-CCY-09. Refund outcomes, selected by the SAME run-scoped, server-side
// selector as PaymentIntent create (the refund's idempotency key). They map onto
// the two refund failure classes production already handles.
describe("fake refunds: selectable outcomes match production's failure classes", () => {
  const RUN = "run-refund0001";
  const KEY = "hone:payment_refund:att-r1:v1";
  const prevRun = process.env.HONE_E2E_RUN_ID;
  const prevFlag = process.env.HONE_E2E_FAKE_STRIPE;
  afterEach(async () => {
    const { clearFakeStripeBehavior, cleanupFakeStripeFiles } = await import("@/lib/stripe/e2e-fake-ledger");
    clearFakeStripeBehavior(RUN);
    cleanupFakeStripeFiles(RUN);
    resetFakeStripeState(RUN);
    if (prevRun === undefined) delete process.env.HONE_E2E_RUN_ID;
    else process.env.HONE_E2E_RUN_ID = prevRun;
    if (prevFlag === undefined) delete process.env.HONE_E2E_FAKE_STRIPE;
    else process.env.HONE_E2E_FAKE_STRIPE = prevFlag;
  });

  async function setup(outcome: "success" | "decline" | "processing") {
    process.env.HONE_E2E_FAKE_STRIPE = "1";
    process.env.HONE_E2E_RUN_ID = RUN;
    const { setFakeStripeBehavior } = await import("@/lib/stripe/e2e-fake-ledger");
    setFakeStripeBehavior(RUN, KEY, outcome);
    const stripe = createFakeStripe();
    const charge = await (stripe.paymentIntents.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ latest_charge: string }>)(
      { amount: 18500, currency: "usd", confirm: true },
      { stripeAccount: "acct_test_r", idempotencyKey: "hone:session_payment:att-r1:v1" },
    );
    const refund = () =>
      (stripe.refunds.create as unknown as (p: unknown, o: unknown) => Promise<{ id: string }>)(
        { charge: charge.latest_charge, amount: 18500 },
        { stripeAccount: "acct_test_r", idempotencyKey: KEY },
      );
    const refundCalls = () => getFakeStripeCalls(RUN).filter((c) => c.method === "refund_create");
    return { refund, refundCalls, chargeId: charge.latest_charge };
  }

  it("decline: a genuine StripeError (production records 'failed'); no refund exists", async () => {
    const { refund, refundCalls } = await setup("decline");
    const StripeSdk = (await import("stripe")).default;
    const err = await refund().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeSdk.errors.StripeError);
    expect(err).toMatchObject({ code: "e2e_fake_refund_refused" });
    expect(refundCalls()).toHaveLength(1);
    expect(refundCalls()[0].resultId).toMatch(/_refused$/);
  });

  it("processing: the refund EXISTS, then a non-Stripe error (production leaves 'pending_stripe')", async () => {
    const { refund, refundCalls } = await setup("processing");
    const StripeSdk = (await import("stripe")).default;
    const err = await refund().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StripeSdk.errors.StripeError);
    const [effect] = refundCalls();
    expect(effect).toMatchObject({ replay: false, amountCents: 18500 });
    expect(effect.resultId).toMatch(/^re_test_e2e_/);
    expect(effect.resultId).not.toMatch(/_refused$/);
  });

  it("success (default): unchanged — a refund in the charge's currency", async () => {
    const { refund, refundCalls } = await setup("success");
    const r = (await refund()) as unknown as { status: string; currency: string; amount: number };
    expect(r).toMatchObject({ status: "succeeded", currency: "usd", amount: 18500 });
    expect(refundCalls()).toHaveLength(1);
  });

  // Codex P2 4264919593: lineage is recorded by the processor itself.
  it("lineage: the create records the charge it produced; the refund records the charge it targeted", async () => {
    const { refund, refundCalls, chargeId } = await setup("success");
    const returned = await refund();
    const [create] = getFakeStripeCalls(RUN).filter((c) => c.method === "pi_create" && !c.replay);
    expect(create.chargeId).toBe(chargeId);
    expect(refundCalls()[0].chargeId).toBe(chargeId);
    expect(returned).toMatchObject({ charge: chargeId, payment_intent: create.resultId });
    // Codex P2 4265803389: both record the connected account they ran on, so an
    // event is delivered under the processor's account, not the row's.
    expect(create.stripeAccount).toBe("acct_test_r");
    expect(refundCalls()[0].stripeAccount).toBe("acct_test_r");
  });

  // Twin finding 2026-10-14: the ledger outlives the server process; ids must not.
  it("ids stay unique across a server restart within one run (continues from the ledger)", async () => {
    await setup("success");
    const create = (key: string) =>
      (createFakeStripe().paymentIntents.create as unknown as (
        p: unknown,
        o: unknown,
      ) => Promise<{ id: string; latest_charge: string }>)(
        { amount: 100, currency: "usd", confirm: true },
        { stripeAccount: "acct_test_r2", idempotencyKey: key },
      );
    const before = await create("hone:session_payment:att-restart-1:v1");
    // A server restart: this process's memory is gone, the run's ledger is not.
    resetFakeStripeState(RUN);
    const after = await create("hone:session_payment:att-restart-2:v1");
    expect(after.id).not.toBe(before.id);
    expect(after.latest_charge).not.toBe(before.latest_charge);
    const { readFakeStripeCalls } = await import("@/lib/stripe/e2e-fake-ledger");
    const ids = readFakeStripeCalls(RUN)
      .filter((c) => c.method === "pi_create" && !c.replay)
      .map((c) => c.resultId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("after a restart, the fake still states money and honours idempotency from the ledger", async () => {
    await setup("success");
    const stripe = () => createFakeStripe();
    const KEY1 = "hone:session_payment:att-restart-m:v1";
    const charge = await (stripe().paymentIntents.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ id: string; latest_charge: string }>)(
      { amount: 15000, currency: "usd", confirm: true },
      { stripeAccount: "acct_test_r3", idempotencyKey: KEY1 },
    );
    resetFakeStripeState(RUN); // restart

    // Retrieve states the original money.
    const got = await (stripe().paymentIntents.retrieve as unknown as (
      id: string,
      p: unknown,
      o: unknown,
    ) => Promise<{ amount: number; currency: string }>)(charge.id, undefined, { stripeAccount: "acct_test_r3" });
    expect(got).toMatchObject({ amount: 15000, currency: "usd" });

    // A retried create with the same key is the SAME PaymentIntent, a replay.
    const again = await (stripe().paymentIntents.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ id: string; amount: number; currency: string }>)(
      { amount: 15000, currency: "usd", confirm: true },
      { stripeAccount: "acct_test_r3", idempotencyKey: KEY1 },
    );
    expect(again).toMatchObject({ id: charge.id, amount: 15000, currency: "usd" });
    const creates = getFakeStripeCalls(RUN).filter((c) => c.method === "pi_create");
    expect(creates.at(-1)).toMatchObject({ resultId: charge.id, replay: true });

    // A refund of the pre-restart charge is in the CHARGE's currency.
    const refund = await (stripe().refunds.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ amount: number; currency: string }>)(
      { charge: charge.latest_charge, amount: 15000 },
      { stripeAccount: "acct_test_r3", idempotencyKey: "hone:payment_refund:att-restart-m:v1" },
    );
    expect(refund).toMatchObject({ amount: 15000, currency: "usd" });
  });
});


describe("fake processor payer evidence for signed webhook fixtures", () => {
  const RUN = "run-payerbind0001";
  afterEach(() => resetFakeStripeState(RUN));
  async function create(customer?: string) {
    process.env.HONE_E2E_RUN_ID = RUN;
    await createFakeStripe().paymentIntents.create({ amount: 18500, currency: "usd", ...(customer ? { customer } : {}) },
      { idempotencyKey: `payer-${getFakeStripeCalls(RUN).length}` });
    return getFakeStripeCalls(RUN).at(-1)!;
  }
  it("records the payer the SDK actually received as a digest, never raw contact/identity", async () => {
    const call = await create("cus_SYNTHETIC_PAYER_SECRETLIKE");
    expect(call.payerDigest).toBe(metadataDigest({ payer: "cus_SYNTHETIC_PAYER_SECRETLIKE" }));
    expect(JSON.stringify(call)).not.toContain("cus_SYNTHETIC_PAYER_SECRETLIKE");
  });
  it("a different supplied payer cannot be repaired by copying a correct row identifier", async () => {
    const wrong = await create("cus_wrong");
    expect(wrong.payerDigest).not.toBe(metadataDigest({ payer: "cus_original" }));
    expect(wrong.payerDigest).toBe(metadataDigest({ payer: "cus_wrong" }));
  });
  it("missing supplied payer stays absent evidence, never a fabricated default", async () => {
    expect((await create()).payerDigest).toBeNull();
  });
  it("an explicitly blank staged SDK payer preserves absent evidence", async () => {
    process.env.HONE_E2E_RUN_ID = RUN;
    await createFakeStripe().paymentIntents.create({ amount: 12000, currency: "usd", customer: "", confirm: false,
      confirmation_method: "manual" }, { idempotencyKey: "blank-staged-payer" });
    expect(getFakeStripeCalls(RUN).at(-1)?.payerDigest).toBeNull();
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
    expect(Object.keys(getFakeStripeCalls()[0]).sort()).toEqual(["method", "idempotencyKey", "stripeAccount", "amountCents", "currency", "resultId", "chargeId", "metadataDigest", "payerDigest", "replay"].sort());
  });
  it("existing browser counters and selector measure confirmation instead of unconfirmed object creation", () => {
    const helper = readFileSync(join(process.cwd(), "e2e-payment/helpers/fake-stripe-ledger-e2e.ts"), "utf8");
    const counters = helper.slice(helper.indexOf("export function readFakeStripeInvocations"), helper.indexOf("export function countFakeStripeInvocations"));
    expect(counters).toContain('c.method === "pi_confirm"'); expect(counters).not.toContain('c.method === "pi_create"');
    expect(readFileSync(join(process.cwd(), "e2e-payment/helpers/payment-fixture.ts"), "utf8")).toContain('`hone:session_payment:${attemptId}:v2:create`');
  });
});


describe("paired staged fake and existing signed-webhook evidence", () => {
  const RUN = "run-paired-proof8126";
  const savedEnv = { ...process.env };
  const id = "33333333-3333-4333-8333-333333333333";
  const account = "acct_test_paired";
  const customer = "cus_test_paired";
  const key = `hone:session_payment:${id}:v2:create`;
  beforeEach(() => {
    process.env = { ...savedEnv, HONE_E2E_FAKE_STRIPE: "1", HONE_E2E_RUN_ID: RUN };
    for (const k of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"]) delete process.env[k];
    resetFakeStripeState(RUN); cleanupFakeStripeFiles(RUN);
  });
  afterEach(() => {
    resetFakeStripeState(RUN); cleanupFakeStripeFiles(RUN); process.env = savedEnv;
  });
  async function setup(outcome: "success" | "processing" = "success") {
    pairedWebhook.row = { id, studio_id: "11111111-1111-4111-8111-111111111111",
      client_id: "22222222-2222-4222-8222-222222222222", session_id: "55555555-5555-4555-8555-555555555555",
      appointment_id: "66666666-6666-4666-8666-666666666666", charge_reason: "session_payment",
      card_authorization_signature_id: "sig_paired", stripe_account_id: account,
      stripe_customer_id: customer, stripe_idempotency_key: key, stripe_charge_id: null };
    const a = pairedWebhook.row;
    const metadata = { hone_studio_id: String(a.studio_id), hone_client_id: String(a.client_id),
      hone_session_id: String(a.session_id), hone_appointment_id: String(a.appointment_id),
      hone_session_payment_charge_attempt_id: id, hone_charge_reason: "session_payment",
      hone_card_authorization_signature_id: "sig_paired", hone_environment: "test" };
    setFakeStripeBehavior(RUN, key, outcome);
    const stripe = createFakeStripe();
    const params = { amount: 12000, currency: "usd", customer, payment_method: "pm_test_paired",
      metadata, confirmation_method: "manual" as const, confirm: false };
    const opts = { stripeAccount: account, idempotencyKey: key };
    const pi = await stripe.paymentIntents.create(params, opts);
    a.stripe_payment_intent_id = pi.id;
    const confirm = async () => {
      const paid = await stripe.paymentIntents.confirm(pi.id, { off_session: true }, {
        stripeAccount: account, idempotencyKey: `hone:session_payment:${id}:v2:confirm:${pi.id}` });
      a.stripe_charge_id = paid.latest_charge;
      return paid;
    };
    const helper = await import("@/e2e-payment/helpers/fake-stripe-webhook");
    return { stripe, pi, params, opts, confirm, helper };
  }
  it("unconfirmed creation cannot supply a fabricated succeeded webhook", async () => {
    const { pi, helper } = await setup();
    expect(pi.latest_charge).toBeNull();
    expect(getFakeStripeCalls(RUN)[0]).toMatchObject({ method: "pi_create", chargeId: null });
    pairedWebhook.row.stripe_charge_id = "ch_fabricated";
    await expect(helper.paymentIntentSucceededEvent(id, {}, RUN)).rejects.toThrow(/produced no charge/);
  });
  it("manual create -> confirm -> refund keeps original money/account/payer/metadata evidence", async () => {
    const { stripe, pi, confirm, helper } = await setup();
    const paid = await confirm();
    const event = await helper.paymentIntentSucceededEvent(id, {}, RUN);
    expect(event).toMatchObject({ type: "payment_intent.succeeded", account,
      data: { object: { id: pi.id, amount: 12000, currency: "usd", customer, latest_charge: paid.latest_charge } } });
    if (typeof paid.latest_charge !== "string") throw new Error("Expected processor charge");
    const refund = await stripe.refunds.create({ charge: paid.latest_charge, amount: 12000 },
      { stripeAccount: account, idempotencyKey: `hone:payment_refund:${id}:v1` });
    expect(refund).toMatchObject({ charge: paid.latest_charge, payment_intent: pi.id, currency: "usd", amount: 12000 });
    const refunded = await helper.chargeRefundedEvent(id, {}, RUN);
    expect(refunded).toMatchObject({ type: "charge.refunded", account,
      data: { object: { id: paid.latest_charge, payment_intent: pi.id, currency: "usd", amount_refunded: 12000, customer } } });
    expect(getFakeStripeCalls(RUN).map(c => c.method)).toEqual(["pi_create", "pi_confirm", "refund_create"]);
  });
  it.each([
    { stripe_customer_id: "cus_other" }, { stripe_account_id: "acct_other" },
    { stripe_charge_id: "ch_other" }, { card_authorization_signature_id: "sig_other" },
  ])("row drift cannot repair processor evidence: %j", async (over) => {
    const { confirm, helper } = await setup(); await confirm(); Object.assign(pairedWebhook.row, over);
    await expect(helper.paymentIntentSucceededEvent(id, {}, RUN)).rejects.toThrow();
  });
  it("contradictory confirm money in the existing ledger refuses a signed event", async () => {
    const { confirm, helper } = await setup(); await confirm();
    const effect = getFakeStripeCalls(RUN).find(c => c.method === "pi_confirm")!;
    const { appendFakeCallToLedger } = await import("@/lib/stripe/e2e-fake-ledger");
    appendFakeCallToLedger(RUN, { ...effect, amountCents: 12001 });
    await expect(helper.paymentIntentSucceededEvent(id, {}, RUN)).rejects.toThrow(/conflicts/);
  });
  it("an explicit later processor success is observed without a second confirm", async () => {
    const { stripe, pi, confirm, helper } = await setup("processing");
    expect((await confirm()).latest_charge).toBeNull();
    await expect(helper.paymentIntentSucceededEvent(id, {}, RUN)).rejects.toThrow(/produced no charge/);
    setFakeStripeBehavior(RUN, key, "success");
    const paid = await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account });
    pairedWebhook.row.stripe_charge_id = paid.latest_charge;
    expect(await helper.paymentIntentSucceededEvent(id, {}, RUN)).toMatchObject({ data: { object: { latest_charge: paid.latest_charge } } });
    expect(getFakeStripeCalls(RUN).filter(c => c.method === "pi_confirm")).toHaveLength(1);
  });
  it("restart cannot recreate a staged original from partial metadata-only evidence", async () => {
    const { stripe, pi, params, opts } = await setup();
    resetFakeStripeState(RUN);
    await expect(stripe.paymentIntents.create(params, opts)).rejects.toThrow(/unavailable after restart/);
    const calls = readFakeStripeCalls(RUN).filter(c => c.method === "pi_create");
    expect(calls.map(c => c.replay)).toEqual([false, true]);
    expect(calls.map(c => c.resultId)).toEqual([pi.id, pi.id]);
    expect(calls.every(c => c.chargeId === null)).toBe(true);
  });
});

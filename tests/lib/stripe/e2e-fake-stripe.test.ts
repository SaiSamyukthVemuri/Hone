import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("fake-call recorder — run-isolated, idempotent, test-safe", () => {
  const RUN = "run-testABC123";
  const prev = process.env.HONE_E2E_RUN_ID;
  afterEach(() => {
    resetFakeStripeState(RUN);
    resetFakeStripeState("run-otherXYZ");
    if (prev === undefined) delete process.env.HONE_E2E_RUN_ID;
    else process.env.HONE_E2E_RUN_ID = prev;
  });

  it("records exactly one call per create + captures idempotency key + connected account + synthetic id", async () => {
    process.env.HONE_E2E_RUN_ID = RUN;
    const stripe = createFakeStripe();
    const pi = await (stripe.paymentIntents.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ id: string; status: string }>)(
      { amount: 22500, currency: "cad" },
      { stripeAccount: "acct_test_123", idempotencyKey: "hone:session_payment:att1:v1" },
    );
    expect(pi.id).toMatch(/^pi_test_e2e_/);
    expect(pi.status).toBe("succeeded");
    const calls = getFakeStripeCalls(RUN);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "pi_create",
      idempotencyKey: "hone:session_payment:att1:v1",
      stripeAccount: "acct_test_123",
      amountCents: 22500,
      currency: "cad",
    });
  });

  it("idempotent replay: same key → same id, NO second recorded call (no double charge)", async () => {
    process.env.HONE_E2E_RUN_ID = RUN;
    const stripe = createFakeStripe();
    const create = stripe.paymentIntents.create as unknown as (
      p: unknown,
      o: unknown,
    ) => Promise<{ id: string }>;
    const a = await create({ amount: 100, currency: "cad" }, { idempotencyKey: "k1" });
    const b = await create({ amount: 100, currency: "cad" }, { idempotencyKey: "k1" });
    expect(a.id).toBe(b.id);
    expect(getFakeStripeCalls(RUN)).toHaveLength(1);
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
    // The recorder type is method/key/account/amount/currency/resultId only.
    const keys = ["method", "idempotencyKey", "stripeAccount", "amountCents", "currency", "resultId"];
    const src = readFileSync(join(process.cwd(), "lib/stripe/e2e-fake-stripe.ts"), "utf8");
    for (const forbidden of ["email", "last4", "customer", "client_id", "card_", "signature", "cvc", "secret"]) {
      // no forbidden field is recorded (the FakeStripeCall type block)
      const typeBlock = src.slice(src.indexOf("export type FakeStripeCall"), src.indexOf("};", src.indexOf("export type FakeStripeCall")));
      expect(typeBlock.toLowerCase()).not.toContain(forbidden);
    }
    expect(keys.length).toBe(6);
  });
});

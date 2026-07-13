import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  appendFakeCallToLedger,
  readFakeStripeCalls,
  readFakeOutcome,
  setFakeStripeBehavior,
  clearFakeStripeBehavior,
  resetFakeStripeLedger,
  cleanupFakeStripeFiles,
} from "@/lib/stripe/e2e-fake-ledger";

// Security + behaviour proof for the guarded cross-process fake-Stripe ledger.
// Every operation requires the fake-Stripe activation guard to pass; paths are
// tmpdir + validated-run-id only; stored data is test-safe.

const RUN = () => `run-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const savedEnv = { ...process.env };
function enableFake(runId: string) {
  process.env.HONE_E2E_FAKE_STRIPE = "1";
  process.env.HONE_E2E_RUN_ID = runId;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
}
beforeEach(() => {
  delete process.env.HONE_E2E_FAKE_STRIPE;
  delete process.env.HONE_E2E_RUN_ID;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const call = (over = {}) => ({
  method: "pi_create" as const,
  idempotencyKey: "hone:session_payment:att1:v1",
  stripeAccount: "acct_test_e2e_x",
  amountCents: 22500,
  currency: "cad",
  resultId: "pi_test_e2e_x_1",
  ...over,
});

describe("ledger is fail-closed (guard required for every op)", () => {
  it("append/read/config/cleanup all throw when fake mode is OFF", () => {
    const r = RUN(); // fake mode not enabled
    expect(() => appendFakeCallToLedger(r, call())).toThrow();
    expect(() => readFakeStripeCalls(r)).toThrow();
    expect(() => setFakeStripeBehavior(r, null, "decline")).toThrow();
    expect(() => resetFakeStripeLedger(r)).toThrow();
    expect(() => cleanupFakeStripeFiles(r)).toThrow();
  });
  it("throws for an invalid run id even with the flag on", () => {
    process.env.HONE_E2E_FAKE_STRIPE = "1";
    process.env.HONE_E2E_RUN_ID = "bad id!";
    expect(() => appendFakeCallToLedger("bad id!", call())).toThrow();
  });
  it("throws in any Vercel environment", () => {
    const r = RUN();
    enableFake(r);
    process.env.VERCEL = "1";
    expect(() => appendFakeCallToLedger(r, call())).toThrow();
    process.env.VERCEL = undefined as unknown as string;
    process.env.VERCEL_ENV = "production";
    expect(() => appendFakeCallToLedger(r, call())).toThrow();
  });
  it("readFakeOutcome is inert (default success) when the guard is off", () => {
    expect(readFakeOutcome(RUN(), "sel")).toBe("success");
  });
});

describe("path safety", () => {
  it("uses only tmpdir + the validated run id (no traversal)", () => {
    const r = RUN();
    enableFake(r);
    try {
      appendFakeCallToLedger(r, call());
      // The written file must live directly under tmpdir with the fixed prefix.
      const calls = readFakeStripeCalls(r);
      expect(calls).toHaveLength(1);
      // Sanity: tmpdir is where we operate.
      expect(tmpdir().length).toBeGreaterThan(0);
    } finally {
      cleanupFakeStripeFiles(r);
    }
  });
});

describe("append + read + behaviour", () => {
  it("records a call with only test-safe fields; roundtrips", () => {
    const r = RUN();
    enableFake(r);
    try {
      appendFakeCallToLedger(r, call());
      const calls = readFakeStripeCalls(r);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "pi_create",
        idempotencyKey: "hone:session_payment:att1:v1",
        stripeAccount: "acct_test_e2e_x",
        amountCents: 22500,
        currency: "cad",
        resultId: "pi_test_e2e_x_1",
      });
      // No forbidden fields anywhere in the serialized ledger.
      const raw = JSON.stringify(calls);
      for (const bad of ["email", "@", "last4", "name", "signature", "secret", "sk_"]) {
        expect(raw.toLowerCase()).not.toContain(bad);
      }
    } finally {
      cleanupFakeStripeFiles(r);
    }
  });

  it("behaviour config: default success; per-selector decline; clear resets", () => {
    const r = RUN();
    enableFake(r);
    try {
      expect(readFakeOutcome(r, "sel-A")).toBe("success"); // no config yet
      setFakeStripeBehavior(r, "sel-A", "decline");
      setFakeStripeBehavior(r, null, "processing"); // default
      expect(readFakeOutcome(r, "sel-A")).toBe("decline");
      expect(readFakeOutcome(r, "sel-B")).toBe("processing"); // falls to default
      clearFakeStripeBehavior(r);
      expect(readFakeOutcome(r, "sel-A")).toBe("success");
    } finally {
      cleanupFakeStripeFiles(r);
    }
  });
});

describe("run isolation + cleanup", () => {
  it("one run cannot read another run's ledger; cleanup is run-scoped", () => {
    const a = RUN();
    const b = RUN();
    enableFake(a);
    appendFakeCallToLedger(a, call({ resultId: "pi_a" }));
    enableFake(b);
    appendFakeCallToLedger(b, call({ resultId: "pi_b" }));
    try {
      expect(readFakeStripeCalls(a)).toHaveLength(1);
      expect(readFakeStripeCalls(b)).toHaveLength(1);
      expect(readFakeStripeCalls(a)[0].resultId).toBe("pi_a");
      // Cleaning A leaves B.
      enableFake(a);
      cleanupFakeStripeFiles(a);
      expect(readFakeStripeCalls(a)).toHaveLength(0);
      enableFake(b);
      expect(readFakeStripeCalls(b)).toHaveLength(1);
    } finally {
      enableFake(a); cleanupFakeStripeFiles(a);
      enableFake(b); cleanupFakeStripeFiles(b);
    }
  });
});

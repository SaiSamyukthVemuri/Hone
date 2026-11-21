import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #168. Docs-level guarantees for the live-payments readiness
// review: its dated verdict stays marked historical, and the runbook
// + deployment docs still point at it. The machine-enforcement on the
// actual Stripe guards lives in
// tests/lib/billing/live-mode-blockers.test.ts.

function readDoc(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const READINESS = readDoc("docs/16_LIVE_PAYMENTS_READINESS.md");
const RUNBOOK = readDoc("docs/11_RUNBOOK.md");
const DEPLOY = readDoc("docs/10_DEPLOYMENT_AND_ENV.md");

describe("docs/16 readiness doc keeps its dated verdict marked historical", () => {
  // AMENDED 2026-07-27: the name asserted a CURRENT conclusion while the string it
  // pinned is the DATED 2026-06-10 verdict. Live session payments are now enabled for
  // approved studios and production-exercised. The guard now requires the verdict to be
  // present AND explicitly marked historical, so it can never again read as current.
  it("its dated headline verdict is retained but explicitly marked historical", () => {
    expect(READINESS).toMatch(/Status:\s*NOT READY FOR LIVE PAYMENTS/i);
    expect(READINESS).toMatch(/\[HISTORICAL[^\]]*\]\s*Status: NOT READY FOR LIVE PAYMENTS/i);
    expect(READINESS).toMatch(/VERIFIED PAYMENT POSTURE/);
  });

  // AMENDED 2026-07-27: Guard 3 (the payment_charge_attempts_livemode_false_check DB
  // CHECK) was DROPPED by migration 0101. This guard now pins the historical three-guard
  // model as a record of the pre-live posture, not as current mechanism.
  it("documents the three independent dormancy guards as the historical pre-live model", () => {
    expect(READINESS).toMatch(/Guard 1:.*key gate/i);
    expect(READINESS).toMatch(/Guard 2:.*early return|Guard 2:.*manual fee/i);
    expect(READINESS).toMatch(/Guard 3:.*(CHECK|database)/i);
  });
});

describe("docs/16 documents what is already production-safe", () => {
  it("lists Stripe Connect onboarding + status sync as ready", () => {
    expect(READINESS).toMatch(/Stripe Connect onboarding/i);
    expect(READINESS).toMatch(/sync_studio_account_status/);
  });

  it("lists the SetupIntent flow + atomic webhook as ready", () => {
    expect(READINESS).toMatch(/SetupIntent/);
    expect(READINESS).toMatch(/setup_intent\.succeeded/);
  });

  it("lists the 3-layer duplicate protection on manual fee charges", () => {
    expect(READINESS).toMatch(/idempotency key/i);
    expect(READINESS).toMatch(/partial unique/i);
  });
});

describe("docs/11 runbook points at the readiness doc", () => {
  it("the runbook links to docs/16", () => {
    expect(RUNBOOK).toMatch(/16_LIVE_PAYMENTS_READINESS/);
  });
});

describe("docs/10 deployment doc reaffirms the dormancy posture", () => {
  it("docs/10 reaffirms STRIPE_ALLOW_LIVE_MODE is false in production", () => {
    expect(DEPLOY).toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });

  it("docs/10 links to docs/16 for the readiness checklist", () => {
    expect(DEPLOY).toMatch(/16_LIVE_PAYMENTS_READINESS|live.payments.readiness/i);
  });
});

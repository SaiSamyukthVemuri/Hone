import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #297 — safety-lock. Live payments are DISABLED and must stay that way
// until a deliberate, reviewed enablement PR removes each gate. This is a
// READ-ONLY source-grep guard: it never calls Stripe and never reads
// production env. If a future change relaxes any layer of the dormancy stack
// WITHOUT updating this test, CI fails — making "live got accidentally
// enabled" impossible to ship silently. The layers mirror docs/16 §17 +
// the enablement sequence in that runbook.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
// Strip // line comments so a docblock that *describes* a gate does not
// satisfy (or trip) a grep that must target the real code.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*--/.test(l))
    .join("\n");
}

const STRIPE_SERVER = read("lib/stripe/server.ts");
const STRIPE_SERVER_CODE = codeOnly(STRIPE_SERVER);
const CHARGE = read("lib/billing/session-payment-charge.ts");
const REFUND = read("lib/billing/payment-refund.ts");
const RECEIPT = read("lib/billing/payment-receipt.ts");
const WEBHOOK_RECON = read("lib/billing/payment-webhook-reconciliation.ts");
const CARD_AUTH = read("lib/consent/current-card-authorization.ts");
const CARD_PTR = read("lib/payment-methods/refresh-card-authorization-pointer.ts");
const MIG_0073 = read("supabase/migrations/0073_payment_charge_attempts.sql");
const MIG_0075 = read(
  "supabase/migrations/0075_claim_session_payment_charge_attempt.sql",
);
const MIG_0075_CODE = codeOnly(MIG_0075);
const STRIPE_GATE_SCRIPT = read("scripts/check-stripe-gates.mjs");

// ---------------------------------------------------------------------------
// Layer 1 — env / key gate (lib/stripe/server.ts)
// ---------------------------------------------------------------------------
describe("Layer 1: Stripe key/env gate still requires explicit live opt-in", () => {
  it("assertStripeKeyAllowed requires STRIPE_ALLOW_LIVE_MODE === 'true' before a live key", () => {
    expect(STRIPE_SERVER_CODE).toMatch(/export function assertStripeKeyAllowed/);
    expect(STRIPE_SERVER_CODE).toMatch(
      /isLiveKey && process\.env\.STRIPE_ALLOW_LIVE_MODE !== "true"/,
    );
    expect(STRIPE_SERVER_CODE).toMatch(/throw new Error\(/);
  });

  it("preview / development deployments still cannot use a live key", () => {
    expect(STRIPE_SERVER_CODE).toMatch(
      /\(vercelEnv === "preview" \|\| vercelEnv === "development"\) && !isTestKey/,
    );
  });

  it("inferStripeLivemode is derived only from an sk_live_ key prefix", () => {
    expect(STRIPE_SERVER_CODE).toMatch(/export function inferStripeLivemode/);
    expect(STRIPE_SERVER_CODE).toMatch(/startsWith\("sk_live_"\)/);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — runtime dormancy guards
// ---------------------------------------------------------------------------
describe("Layer 2: runtime dormancy guards still block live mode", () => {
  it("the charge path still returns live_mode_blocked (env + row guard)", () => {
    expect(CHARGE).toMatch(/inferStripeLivemode\(\) === true/);
    expect(CHARGE).toMatch(/outcome: "live_mode_blocked"/);
    expect(CHARGE).toMatch(/stripe_livemode !== false/);
  });

  it("the refund path still returns live_mode_blocked (env + row guard)", () => {
    expect(REFUND).toMatch(/if \(inferStripeLivemode\(\)\)/);
    expect(REFUND).toMatch(/outcome: "live_mode_blocked"/);
    expect(REFUND).toMatch(/stripe_livemode !== false/);
  });

  it("the receipt path still refuses live-mode rows and the template stays dormant", () => {
    expect(RECEIPT).toMatch(/attempt\.stripe_livemode !== false/);
    // The receipt email template is hardcoded test-mode until live enablement.
    expect(RECEIPT).toMatch(/livemode: false/);
  });

  it("card-authorization lookups stay scoped to the running process's livemode", () => {
    for (const src of [CARD_AUTH, CARD_PTR]) {
      expect(src).toMatch(/inferStripeLivemode\(\)/);
      expect(src).toMatch(/\.eq\("stripe_livemode", livemode\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — DB structural guards (migration source)
// ---------------------------------------------------------------------------
describe("Layer 3: DB structural dormancy guards still present in migration source", () => {
  it("payment_charge_attempts_livemode_false_check (stripe_livemode = false) still exists", () => {
    expect(MIG_0073).toMatch(/payment_charge_attempts_livemode_false_check/);
    expect(MIG_0073).toMatch(/check \(stripe_livemode = false\)/);
  });

  it("the claim RPC mirror still returns not_ready for any non-test-mode row", () => {
    expect(MIG_0075_CODE).toMatch(/stripe_livemode <> false/);
    expect(MIG_0075_CODE).toMatch(/not_ready/);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — webhook livemode block
// ---------------------------------------------------------------------------
describe("Layer 4: webhook still ignores live-mode events", () => {
  it("shouldIgnoreLiveModeEvent still exists and records the ignored event", () => {
    expect(WEBHOOK_RECON).toMatch(/function shouldIgnoreLiveModeEvent/);
    expect(WEBHOOK_RECON).toMatch(/event\.livemode !== true && ctx\.livemode !== true/);
    expect(WEBHOOK_RECON).toMatch(/stripe_webhook_livemode_event_ignored/);
  });
});

// ---------------------------------------------------------------------------
// Static Stripe-gate rules unchanged (1 PI / 1 refund / 0 charges / 0 checkout)
// ---------------------------------------------------------------------------
describe("static Stripe gates remain 1/1/0/0", () => {
  const rule = (name: string) =>
    new RegExp(
      `name:\\s*"${name.replace(".", "\\.")}"[\\s\\S]{0,1500}?exactly:\\s*(\\d+)`,
    );
  it("paymentIntents.create exactly 1", () => {
    const m = STRIPE_GATE_SCRIPT.match(rule("paymentIntents.create"));
    expect(m?.[1]).toBe("1");
  });
  it("refunds.create exactly 1", () => {
    const m = STRIPE_GATE_SCRIPT.match(rule("refunds.create"));
    expect(m?.[1]).toBe("1");
  });
  it("charges.create exactly 0", () => {
    const m = STRIPE_GATE_SCRIPT.match(rule("charges.create"));
    expect(m?.[1]).toBe("0");
  });
  it("checkout.sessions exactly 0", () => {
    const m = STRIPE_GATE_SCRIPT.match(rule("checkout.sessions"));
    expect(m?.[1]).toBe("0");
  });
  it("STRIPE_ALLOW_LIVE_MODE=true is allowlisted to lib/stripe/server.ts only", () => {
    expect(STRIPE_GATE_SCRIPT).toMatch(/STRIPE_ALLOW_LIVE_MODE=true/);
    expect(STRIPE_GATE_SCRIPT).toMatch(/lib\/stripe\/server\.ts/);
  });
});

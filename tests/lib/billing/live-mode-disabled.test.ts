import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #297 safety-lock, REPOINTED at PR #323 to the ENV-GATED model.
//
// Live payments are still DISABLED — but the dormancy model changed. Before
// #323 the money paths HARDCODED stripe_livemode=false. After #322 (DB) + #323
// (runtime) they are now live-CAPABLE, and live is off SOLELY because:
//   * the env/key gate (Layer 1) rejects an sk_live_ key unless
//     STRIPE_ALLOW_LIVE_MODE === "true" (unset today), so inferStripeLivemode()
//     is false; and
//   * every money-path guard is gated on inferStripeLivemode() (Layer 2) — with
//     it false, they enforce test-mode exactly as before, and no runtime path
//     ever WRITES a live row (prepare-inserts write inferStripeLivemode()).
// So this test now asserts the guards are DYNAMIC (compare inferStripeLivemode()
// / livemode), NOT hardcoded false, and that no stale hardcoded-false literal
// remains in the money paths. The env flip (#324) is what turns it on. This is a
// READ-ONLY source-grep guard; it never calls Stripe or reads production env.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*--/.test(l))
    .join("\n");
}

const STRIPE_SERVER_CODE = codeOnly(read("lib/stripe/server.ts"));
const STRIPE_LIVEMODE_CODE = read("lib/stripe/livemode.ts");
const CHARGE = read("lib/billing/session-payment-charge.ts");
const CHARGE_CODE = codeOnly(CHARGE);
const REFUND_CODE = codeOnly(read("lib/billing/payment-refund.ts"));
const RECEIPT_CODE = codeOnly(read("lib/billing/payment-receipt.ts"));
const WEBHOOK_CODE = codeOnly(read("lib/billing/payment-webhook-reconciliation.ts"));
const CARD_AUTH = read("lib/consent/current-card-authorization.ts");
const CARD_PTR = read("lib/payment-methods/refresh-card-authorization-pointer.ts");
const PREPARE = codeOnly(
  read("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts"),
);
const FEE_PREPARE = codeOnly(read("app/(app)/calendar/[id]/manual-fee-actions.ts"));
const MIG_0101 = codeOnly(
  read("supabase/migrations/0101_live_payment_charge_attempts_db_readiness.sql"),
);
const STRIPE_GATE_SCRIPT = read("scripts/check-stripe-gates.mjs");

// The money-path modules whose dormancy is now env-gated. No stale hardcoded
// stripe_livemode=false may remain in any of them (that was the pre-#323 model).
const MONEY_PATHS = { CHARGE_CODE, REFUND_CODE, RECEIPT_CODE, WEBHOOK_CODE, PREPARE, FEE_PREPARE };

// ---------------------------------------------------------------------------
// Layer 1 — env / key gate (unchanged; this is now the PRIMARY reason live is off)
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
    // THE RULE MOVED, THE RULE DID NOT CHANGE. It now lives in
    // lib/stripe/livemode.ts, a leaf module with no imports, so a caller that
    // needs only the MODE does not acquire the Stripe SDK with it — the owner
    // Financials surface proves it makes no Stripe call by walking its static
    // import closure, and importing the flag from lib/stripe/server.ts would
    // put the SDK inside that closure.
    //
    // WHAT THIS TEST PROTECTS IS UNCHANGED: exactly one definition, derived
    // from nothing but the key prefix. Both halves are asserted — the leaf
    // defines it, and lib/stripe/server.ts re-exports rather than redefining,
    // so a second copy cannot appear without failing here.
    expect(STRIPE_LIVEMODE_CODE).toMatch(/export function inferStripeLivemode/);
    expect(STRIPE_LIVEMODE_CODE).toMatch(/startsWith\("sk_live_"\)/);
    expect(STRIPE_LIVEMODE_CODE).toMatch(/process\.env\.STRIPE_SECRET_KEY/);

    expect(STRIPE_SERVER_CODE).toMatch(
      /export \{ inferStripeLivemode \} from "\.\/livemode"/,
    );
    expect(STRIPE_SERVER_CODE, "no second definition").not.toMatch(
      /export function inferStripeLivemode/,
    );

    // The leaf imports nothing, which is the property that makes it safe to
    // depend on from a surface that must not reach Stripe.
    expect(codeOnly(STRIPE_LIVEMODE_CODE)).not.toMatch(/^\s*import\s/m);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — runtime guards are ENV-GATED on inferStripeLivemode() (not false)
// ---------------------------------------------------------------------------
describe("Layer 2: runtime money-path guards are env-gated, not hardcoded false", () => {
  it("the charge path uses inferStripeLivemode() + a mode-consistency row guard", () => {
    expect(CHARGE_CODE).toMatch(/const livemode = inferStripeLivemode\(\)/);
    expect(CHARGE_CODE).toMatch(/attemptRow\.stripe_livemode !== livemode/);
    expect(CHARGE_CODE).toMatch(/outcome: "live_mode_blocked"/);
    // The old hard env early-return + hardcoded false row guard are gone.
    expect(CHARGE_CODE).not.toMatch(/inferStripeLivemode\(\) === true/);
    expect(CHARGE_CODE).not.toMatch(/stripe_livemode !== false/);
  });
  it("the refund path is env-gated (mode-consistency, not hardcoded false)", () => {
    expect(REFUND_CODE).toMatch(/const livemode = inferStripeLivemode\(\)/);
    expect(REFUND_CODE).toMatch(/attempt\.stripe_livemode !== livemode/);
    expect(REFUND_CODE).toMatch(/outcome: "live_mode_blocked"/);
    expect(REFUND_CODE).not.toMatch(/stripe_livemode !== false/);
  });
  it("the receipt guard is env-gated (live-CAPABLE) + passes the row's real mode", () => {
    expect(RECEIPT_CODE).toMatch(/attempt\.stripe_livemode !== inferStripeLivemode\(\)/);
    expect(RECEIPT_CODE).toMatch(/livemode: attempt\.stripe_livemode/);
    expect(RECEIPT_CODE).not.toMatch(/livemode: false/);
  });
  it("card-authorization lookups stay scoped to the running process's livemode", () => {
    for (const src of [CARD_AUTH, CARD_PTR]) {
      expect(src).toMatch(/inferStripeLivemode\(\)/);
      expect(src).toMatch(/\.eq\("stripe_livemode", livemode\)/);
    }
  });
  it("prepare-inserts write stripe_livemode: inferStripeLivemode() (false in test env)", () => {
    expect(PREPARE).toMatch(/stripe_livemode: inferStripeLivemode\(\)/);
    expect(FEE_PREPARE).toMatch(/stripe_livemode: inferStripeLivemode\(\)/);
  });
  it("PaymentIntent + refund metadata hone_environment is dynamic (not hardcoded test)", () => {
    expect(CHARGE_CODE).toMatch(/hone_environment: livemode \? "live" : "test"/);
    expect(REFUND_CODE).toMatch(/hone_environment: livemode \? "live" : "test"/);
    expect(CHARGE_CODE).not.toMatch(/hone_environment: "test"/);
  });
  it("NO stale hardcoded stripe_livemode=false remains anywhere in the money paths", () => {
    for (const [name, code] of Object.entries(MONEY_PATHS)) {
      expect(code, `${name} still has a hardcoded stripe_livemode false`).not.toMatch(
        /stripe_livemode !== false|stripe_livemode === false|\.eq\("stripe_livemode", false\)|stripe_livemode: false/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — DB is now live-CAPABLE (0101); dormancy shifted to env/runtime
// ---------------------------------------------------------------------------
describe("Layer 3: DB is live-capable via 0101 (dormancy is now env/runtime)", () => {
  it("0101 replaced the livemode-false CHECK with the account-requiring CHECK", () => {
    expect(MIG_0101).toMatch(
      /drop constraint if exists\s+payment_charge_attempts_livemode_false_check/i,
    );
    expect(MIG_0101).toMatch(
      /check\s*\(\s*stripe_livemode\s*=\s*false\s+or\s+stripe_account_id\s+is\s+not\s+null\s*\)/i,
    );
  });
  it("0101 relaxed the claim RPC (no longer refuses live rows)", () => {
    expect(MIG_0101).toMatch(
      /create or replace function public\.claim_session_payment_charge_attempt/i,
    );
    expect(MIG_0101).not.toMatch(/stripe_livemode <> false/);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — webhook now MODE-MATCHES the deployment (ignore mismatched safely)
// ---------------------------------------------------------------------------
describe("Layer 4: webhook processes only deployment-mode events", () => {
  it("shouldIgnoreLiveModeEvent compares event.livemode to inferStripeLivemode()", () => {
    expect(WEBHOOK_CODE).toMatch(/function shouldIgnoreLiveModeEvent/);
    expect(WEBHOOK_CODE).toMatch(/const deploymentLive = inferStripeLivemode\(\)/);
    expect(WEBHOOK_CODE).toMatch(/eventLive === deploymentLive/);
    expect(WEBHOOK_CODE).toMatch(/stripe_webhook_livemode_event_ignored/);
    // The old "ignore whenever either is live" logic is gone.
    expect(WEBHOOK_CODE).not.toMatch(/event\.livemode !== true && ctx\.livemode !== true/);
  });
  it("the per-handler row backstops are mode-consistency (not hardcoded false)", () => {
    expect(WEBHOOK_CODE).toMatch(/attempt\.stripe_livemode !== inferStripeLivemode\(\)/);
    expect(WEBHOOK_CODE).not.toMatch(/attempt\.stripe_livemode !== false/);
  });
});

// ---------------------------------------------------------------------------
// Static Stripe-gate money inventory unchanged (1 PI / 1 refund / 0 / 0)
// ---------------------------------------------------------------------------
describe("static Stripe gates remain 1/1/0/0", () => {
  const rule = (name: string) =>
    new RegExp(
      `name:\\s*"${name.replace(".", "\\.")}"[\\s\\S]{0,1500}?exactly:\\s*(\\d+)`,
    );
  it("paymentIntents.create exactly 1", () => {
    expect(STRIPE_GATE_SCRIPT.match(rule("paymentIntents.create"))?.[1]).toBe("1");
  });
  it("refunds.create exactly 1", () => {
    expect(STRIPE_GATE_SCRIPT.match(rule("refunds.create"))?.[1]).toBe("1");
  });
  it("charges.create exactly 0", () => {
    expect(STRIPE_GATE_SCRIPT.match(rule("charges.create"))?.[1]).toBe("0");
  });
  it("checkout.sessions exactly 0", () => {
    expect(STRIPE_GATE_SCRIPT.match(rule("checkout.sessions"))?.[1]).toBe("0");
  });
  it("STRIPE_ALLOW_LIVE_MODE=true is allowlisted to lib/stripe/server.ts only", () => {
    expect(STRIPE_GATE_SCRIPT).toMatch(/STRIPE_ALLOW_LIVE_MODE=true/);
    expect(STRIPE_GATE_SCRIPT).toMatch(/lib\/stripe\/server\.ts/);
  });
});

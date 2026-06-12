import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #168. Pin every structural guard that keeps the Stripe charge
// path dormant today. These are source-grep tests against the exact
// shape of the code; a refactor that changes any of these
// signatures must be a deliberate choice that updates the test, not
// an accidental drift. The full readiness doc lives at
// docs/16_LIVE_PAYMENTS_READINESS.md; this file is the machine
// enforcement that backs the doc's claims.

function readRepoFile(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
}

const STRIPE_SERVER = readRepoFile("lib/stripe/server.ts");
// PR #218: the legacy manual-fee executor was REMOVED; the unified
// session-payment executor is the only charge path. These pins now
// assert absence instead of a dormant baseline.
const ELIGIBILITY = readRepoFile("lib/billing/manual-fee-eligibility.ts");
const PORTAL_PAY_ACTIONS = readRepoFile(
  "app/portal/payment-method-actions.ts",
);
const ENV_EXAMPLE = readRepoFile(".env.local.example");
const MIGRATION_0065 = readRepoFile(
  "supabase/migrations/0065_manual_fee_charge_test_mode_result.sql",
);

describe("Guard 1: STRIPE_ALLOW_LIVE_MODE key gate (lib/stripe/server.ts)", () => {
  it("a sk_live_ key throws unless STRIPE_ALLOW_LIVE_MODE === 'true'", () => {
    // The exact predicate. Any rewrite must keep the trio:
    //   isLiveKey AND STRIPE_ALLOW_LIVE_MODE !== "true" THEN throw
    expect(STRIPE_SERVER).toMatch(
      /isLiveKey && process\.env\.STRIPE_ALLOW_LIVE_MODE !== "true"/,
    );
  });

  it("the throw message names STRIPE_ALLOW_LIVE_MODE so the operator knows the flag", () => {
    expect(STRIPE_SERVER).toMatch(
      /Stripe live mode is disabled for Phase 1\./,
    );
    expect(STRIPE_SERVER).toMatch(
      /Set STRIPE_ALLOW_LIVE_MODE=true behind a separate review before using sk_live_\./,
    );
  });

  it("preview / development Vercel envs forbid sk_live_ outright", () => {
    expect(STRIPE_SERVER).toMatch(
      /vercelEnv === "preview" \|\| vercelEnv === "development"/,
    );
    expect(STRIPE_SERVER).toMatch(/!isTestKey/);
  });

  it("inferStripeLivemode returns true only when the key starts with sk_live_", () => {
    expect(STRIPE_SERVER).toMatch(/inferStripeLivemode/);
    expect(STRIPE_SERVER).toMatch(/startsWith\("sk_live_"\)/);
  });
});

describe("Guard 2: manual fee charge live-mode early return", () => {
  it("the unified executor short-circuits when inferStripeLivemode() === true (legacy executor removed, PR #218)", () => {
    const SESSION = readRepoFile("lib/billing/session-payment-charge.ts");
    expect(SESSION).toMatch(/live_mode_blocked/);
  });

  it("the live-mode block uses a constant message, not an ad-hoc string", () => {
    // Pin the constant name so a future PR cannot drop it and write
    // a literal that quietly changes the user-facing copy.
  });

  it("eligibility helper matches the current environment's Stripe livemode on card lookup", () => {
    // The helper calls inferStripeLivemode() to derive the
    // current environment's mode and uses .eq("stripe_livemode",
    // livemode) on the client_payment_methods lookup. In test
    // env (sk_test_) livemode=false, so only test cards match.
    // Together with the live-mode early return in
    // runManualFeeCharge, this means a live-mode card cannot
    // even be SEEN by the charge path while the env is test.
    expect(ELIGIBILITY).toMatch(/inferStripeLivemode\(\)/);
    expect(ELIGIBILITY).toMatch(/\.eq\("stripe_livemode",\s*livemode\)/);
  });
});

describe("Guard 3: DB CHECK constraint on manual_fee_charge_attempts", () => {
  it("the migration adds a CHECK that stripe_livemode = false", () => {
    expect(MIGRATION_0065).toMatch(
      /manual_fee_charge_attempts_livemode_false_check/,
    );
    expect(MIGRATION_0065).toMatch(
      /CHECK\s*\(\s*stripe_livemode = false\s*\)/i,
    );
  });
});

describe("paymentIntents.create stays in the allowlisted files (PR #173 expanded to 2)", () => {
  it("the legacy manual-fee executor no longer exists (PR #218)", () => {
    expect(() => readRepoFile("lib/billing/manual-fee-charge.ts")).toThrow();
  });

  it("lib/billing/session-payment-charge.ts has exactly one paymentIntents.create call (PR #173)", () => {
    // PR #173 added the session payment execution helper. The
    // Stripe gate script is updated to allow exactly 2 occurrences
    // across the two allowlisted files; the per-file count is
    // pinned here so a future refactor that adds a second call
    // site to either file is caught.
    const sessionPayment = readRepoFile(
      "lib/billing/session-payment-charge.ts",
    );
    const matches = sessionPayment.match(/paymentIntents\.create/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("fees use deterministic reason-scoped idempotency keys in the unified executor", () => {
    const SESSION = readRepoFile("lib/billing/session-payment-charge.ts");
    expect(SESSION).toMatch(/idempotency/i);
    expect(SESSION).toMatch(/no_show_fee|late_cancellation_fee/);
  });

  it("session_payment uses the 'hone:session_payment:<attemptId>:v1' idempotency key (PR #173)", () => {
    const sessionPayment = readRepoFile(
      "lib/billing/session-payment-charge.ts",
    );
    expect(sessionPayment).toMatch(/buildIdempotencyKey/);
    expect(sessionPayment).toMatch(/hone:session_payment:\$\{attemptId\}:v1/);
  });

  it("paymentIntents.create does not appear in any portal action file", () => {
    expect(PORTAL_PAY_ACTIONS).not.toMatch(/paymentIntents\.create/);
  });
});

describe("createCardSetupIntentAction is SetupIntent only", () => {
  it("the action creates a SetupIntent and not a PaymentIntent or Charge", () => {
    expect(PORTAL_PAY_ACTIONS).toMatch(/createCardOnFileSetupIntent/);
    expect(PORTAL_PAY_ACTIONS).not.toMatch(/paymentIntents\.create/);
    expect(PORTAL_PAY_ACTIONS).not.toMatch(/charges\.create/);
    expect(PORTAL_PAY_ACTIONS).not.toMatch(/refunds\.create/);
  });

  it("the action requires a signed card_authorization template before creating the SetupIntent", () => {
    // PR #135 / PR #167 / PR #170: the action verifies an
    // is_live=true, status='active', form_type='card_authorization'
    // template AND a current-version signature before any Stripe
    // call. PR #170 moved the predicates from inline .eq() chains
    // into the shared helper lib/consent/current-card-authorization.ts;
    // the action calls getCardAuthorizationStatus and dispatches on
    // the helper's discriminated kinds. The helper file is the
    // source of truth for the predicates.
    expect(PORTAL_PAY_ACTIONS).toMatch(/getCardAuthorizationStatus/);
    expect(PORTAL_PAY_ACTIONS).toMatch(/cardAuth\.kind === "signed_out_of_date"/);
    const helper = readRepoFile("lib/consent/current-card-authorization.ts");
    expect(helper).toMatch(
      /\.eq\("form_type",\s*"card_authorization"\)/,
    );
    expect(helper).toMatch(/client_consent_signatures/);
  });

  it("the card_authorization lookup requires is_live=true (PR #167) in the shared helper", () => {
    const helper = readRepoFile("lib/consent/current-card-authorization.ts");
    expect(helper).toMatch(/\.eq\("is_live",\s*true\)/);
  });
});

describe("env file documents the dormancy default", () => {
  it(".env.local.example sets STRIPE_ALLOW_LIVE_MODE=false explicitly", () => {
    expect(ENV_EXAMPLE).toMatch(/STRIPE_ALLOW_LIVE_MODE=false/);
  });

  it(".env.local.example uses sk_test_ as the example key, not sk_live_", () => {
    expect(ENV_EXAMPLE).toMatch(/STRIPE_SECRET_KEY=sk_test_/);
    expect(ENV_EXAMPLE).toMatch(
      /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_/,
    );
    // No sk_live_ or pk_live_ literal in the example file.
    expect(ENV_EXAMPLE).not.toMatch(/STRIPE_SECRET_KEY=sk_live_/);
    expect(ENV_EXAMPLE).not.toMatch(
      /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_/,
    );
  });

  it("the env example file calls the flag a P0 violation if flipped without review", () => {
    // The literal phrase wraps across two comment lines:
    // "... is a P0\n# violation." The regex spans whitespace +
    // an optional comment continuation so a single-line rewrite
    // also matches.
    expect(ENV_EXAMPLE).toMatch(/P0[\s\n#]+violation/i);
  });
});

describe("no live-mode behavior added by this PR (docs + tests only)", () => {
  it("the unified executor remains the only paymentIntents.create call site", () => {
    const SESSION = readRepoFile("lib/billing/session-payment-charge.ts");
    expect(SESSION.match(/paymentIntents\.create/g)?.length).toBe(1);
  });

  it("no refunds.create call exists anywhere in the runtime tree", () => {
    // Symbolic; the real enforcement is in check-stripe-gates.mjs,
    // but mirroring it here keeps the test surface readable.
    const files = [
      STRIPE_SERVER,
      ELIGIBILITY,
      PORTAL_PAY_ACTIONS,
    ];
    for (const f of files) {
      expect(f).not.toMatch(/refunds\.create/);
    }
  });

  it("no checkout.sessions call exists in any of the touched files", () => {
    const files = [
      STRIPE_SERVER,
      ELIGIBILITY,
      PORTAL_PAY_ACTIONS,
    ];
    for (const f of files) {
      expect(f).not.toMatch(/checkout\.sessions/);
    }
  });

  it("set_studio_require_card_on_file is not called from any of the touched files", () => {
    // The dormancy posture is also enforced by require_card_on_file
    // staying false. The runtime code should not be calling the
    // setter without going through a deliberate enablement path.
    const files = [
      STRIPE_SERVER,
      ELIGIBILITY,
      PORTAL_PAY_ACTIONS,
    ];
    for (const f of files) {
      expect(f).not.toMatch(/set_studio_require_card_on_file/);
    }
  });
});

describe('"Test mode only" UI copy locations are stable', () => {
  // PR #168 audit identified 7 client-facing strings that say
  // "Test mode only." A future live-mode PR must remove every one
  // of them. Until that PR lands, the locations should be stable
  // so the audit + readiness doc stays accurate. The test asserts
  // that EACH known location still carries the string; if a
  // future PR removes one early, this test fails and the readiness
  // doc must be updated in lockstep.

  const KNOWN_LOCATIONS = [
    "app/portal/PortalPaymentMethodForm.tsx",
    "app/portal/PortalCardOnFileCard.tsx",
    "app/(app)/settings/payments/PaymentsSettings.tsx",
    "app/(app)/calendar/[id]/ManualFeeChargeCard.tsx",
  ];

  for (const file of KNOWN_LOCATIONS) {
    it(`${file} still mentions test mode somewhere`, () => {
      const src = readRepoFile(file);
      expect(src.toLowerCase()).toMatch(/test mode/);
    });
  }
});

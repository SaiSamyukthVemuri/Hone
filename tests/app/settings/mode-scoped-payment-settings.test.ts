import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Migration 0103 companion: a studio can hold one studio_payment_settings row
// per Stripe mode, so EVERY runtime read of the table must be scoped to the
// CURRENT deployment mode — an unscoped studio_id-only .maybeSingle() errors
// the moment a studio has both a test and a live row, and an unscoped read is
// exactly the production bug that handed the LIVE key a TEST acct_ id
// (StripePermissionError account_invalid). This suite pins:
//   * every .from("studio_payment_settings") read carries a stripe_livemode
//     filter derived from a VARIABLE (inferStripeLivemode() / livemode /
//     ctx.livemode) — never a hardcoded literal
//   * both get_studio_payment_settings_display callers pass p_stripe_livemode
//   * live runtime can therefore never retrieve/login/link the other mode's
//     account id

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

// Every runtime file that queries the table directly (from the exhaustive
// pre-fix inventory). If a NEW .from("studio_payment_settings") call site
// appears elsewhere, the repo-wide scan below catches it.
// Deliberately BOTH-mode reader (PR B): the admin status helper fetches a
// studio's test AND live settings rows to display them side by side, and
// splits every count by the ROW's own stripe_livemode — mode-correct by
// construction, so it is exempt from the per-block current-mode filter rule
// below (its platform-summary read IS current-mode scoped).
const BOTH_MODE_READERS = ["lib/payments/admin-payment-status.ts"];

const TABLE_READERS = [
  "app/portal/payment-method-actions.ts",
  "app/(app)/settings/payments/actions.ts",
  "app/(app)/settings/payments/return/page.tsx",
  "app/api/stripe/webhook/route.ts",
  "lib/billing/session-payment-charge.ts",
  "lib/billing/session-payment-eligibility.ts",
  "lib/stripe/account.ts",
];

describe("every studio_payment_settings read is mode-scoped", () => {
  for (const file of TABLE_READERS) {
    it(`${file}: each .from("studio_payment_settings") block filters by stripe_livemode`, () => {
      const src = read(file);
      const blocks = src.split('.from("studio_payment_settings")').slice(1);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        // The filter chain ends at the terminal call; the mode filter must
        // appear within it.
        const chain = block.slice(0, block.indexOf("maybeSingle") + 1 || 400);
        expect(chain).toMatch(/\.eq\("stripe_livemode",\s*(inferStripeLivemode\(\)|livemode|ctx\.livemode)\)/);
      }
    });
  }

  it("no reader uses a hardcoded livemode literal (env-gated model preserved)", () => {
    for (const file of TABLE_READERS) {
      const src = read(file);
      expect(src).not.toMatch(/\.eq\("stripe_livemode",\s*(false|true)\)/);
    }
  });

  it("repo-wide: no UNSCOPED .from(\"studio_payment_settings\") exists outside the known readers", () => {
    // The known-reader list above must stay the complete set: this test is a
    // tripwire for a future file adding an unscoped read. (Scan is driven by
    // the same source files the bundler compiles; tests/migrations excluded.)
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(
      `grep -rl '\\.from("studio_payment_settings")' app lib components --include='*.ts' --include='*.tsx' || true`,
      { cwd: path.resolve(__dirname, "../../../"), encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(out).toEqual([...TABLE_READERS, ...BOTH_MODE_READERS].sort());
  });
});

describe("get_studio_payment_settings_display callers pass the deployment mode", () => {
  it("Settings → Payments page passes p_stripe_livemode: inferStripeLivemode()", () => {
    const src = read("app/(app)/settings/payments/page.tsx");
    expect(src).toMatch(
      /get_studio_payment_settings_display",\s*\n?\s*\{ p_studio_id: studio\.id, p_stripe_livemode: inferStripeLivemode\(\) \}/,
    );
  });

  it("dashboard payment status passes p_stripe_livemode: inferStripeLivemode()", () => {
    const src = read("app/(app)/dashboard/page.tsx");
    expect(src).toMatch(
      /get_studio_payment_settings_display",\s*\n?\s*\{ p_studio_id: studioId, p_stripe_livemode: inferStripeLivemode\(\) \}/,
    );
  });
});

describe("live runtime can never touch the other mode's account id", () => {
  it("refresh + dashboard-login actions load the account id mode-scoped", () => {
    const src = read("app/(app)/settings/payments/actions.ts");
    // Both account-id loads in this file are scoped (asserted per-block above);
    // additionally pin that the Stripe calls only ever receive the loaded
    // settings row's account id (no other acct source in this file).
    expect(src).toMatch(/stripeAccountId: settings\.stripe_account_id/);
    expect(src).toMatch(/createExpressDashboardLoginLink\(settings\.stripe_account_id\)/);
  });

  it("the onboarding return page syncs the current-mode account only", () => {
    const src = read("app/(app)/settings/payments/return/page.tsx");
    expect(src).toMatch(/\.eq\("stripe_livemode", inferStripeLivemode\(\)\)/);
    expect(src).toMatch(/stripeAccountId: settings\.stripe_account_id/);
  });

  it("createOrLoadConnectedAccountForStudio remains mode-parameterized (RPC claim carries livemode)", () => {
    const src = read("lib/stripe/account.ts");
    expect(src).toMatch(/create_or_claim_stripe_account_provisioning/);
    expect(src).toMatch(/p_stripe_livemode:\s*livemode/);
  });
});

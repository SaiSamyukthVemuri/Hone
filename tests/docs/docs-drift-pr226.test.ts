import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// PR #226. Post-hardening docs drift pins. After PRs #217-#225 a
// fresh review found root-level and operational docs still
// describing the pre-hardening world (deleted executor as the
// allowed charge path, DB/RLS suite "not built", refunds "zero").
// These pins lock the corrected claims and the no-overclaim posture.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const README = read("README.md");
const CONTRIBUTING = read("CONTRIBUTING.md");
const OVERVIEW = read("docs/00_PRODUCT_OVERVIEW.md");
const SECURITY = read("docs/03_SECURITY_AND_PRIVACY.md");
const OPS_RUNBOOK = read("docs/11_RUNBOOK.md");
const HANDOFF = read("docs/14_AI_HANDOFF.md");

describe("canonical charge path", () => {
  it("CONTRIBUTING names session-payment-charge.ts as the only paymentIntents.create file", () => {
    expect(CONTRIBUTING).toMatch(
      /exactly one runtime occurrence, in `lib\/billing\/session-payment-charge\.ts`/,
    );
    expect(CONTRIBUTING).not.toMatch(
      /allowed in `lib\/billing\/manual-fee-charge\.ts`/,
    );
    expect(CONTRIBUTING).toMatch(/scripts\/check-stripe-gates\.mjs/);
  });

  it("no doc presents the deleted executor as the active charge path", () => {
    for (const [name, doc] of [
      ["README", README],
      ["CONTRIBUTING", CONTRIBUTING],
      ["docs/11", OPS_RUNBOOK],
    ] as const) {
      // Mentions are fine only alongside deleted/legacy framing.
      const lines = doc
        .split("\n")
        .filter((l) => l.includes("manual-fee-charge.ts"))
        .filter((l) => !/deleted|legacy|removed|was/i.test(l));
      expect(lines, `${name} still presents manual-fee-charge.ts as active`).toEqual([]);
    }
  });

  it("docs/11 dormancy recipe expects the canonical executor and checks both ledgers", () => {
    expect(OPS_RUNBOOK).toMatch(
      /PASS paymentIntents\.create \(1 occurrence in lib\/billing\/session-payment-charge\.ts\)/,
    );
    expect(OPS_RUNBOOK).toMatch(
      /payment_charge_attempts where stripe_livemode = true/,
    );
  });

  it("docs/14 current-guidance sections name the canonical path and real refund count", () => {
    expect(HANDOFF).toMatch(
      /allowed only in `lib\/billing\/session-payment-charge\.ts`/,
    );
    expect(HANDOFF).toMatch(
      /refunds\.create:\s+exactly one \(lib\/billing\/payment-refund\.ts/,
    );
    expect(HANDOFF).not.toMatch(/allowed only in `lib\/billing\/manual-fee-charge\.ts`/);
  });

  it("README names the canonical payment_charge_attempts ledger + current live-payment posture", () => {
    // Still names the canonical ledger (not the deleted manual_fee_charge executor)...
    expect(README).toMatch(/`payment_charge_attempts` ledger/);
    // ...and states the CURRENT posture (supervised live for approved studios; broad self-serve not ready).
    expect(README).toMatch(/live for approved studios/i);
    expect(README).toMatch(/broad self-serve live-payment rollout is not complete|broad self-serve live payments are not ready/i);
  });
});

describe("DB/RLS and types coverage acknowledged", () => {
  it("README describes the db-integration job and both DB-lane checks", () => {
    expect(README).toMatch(/db-integration/);
    expect(README).toMatch(/npm run test:db/);
    expect(README).toMatch(/npm run check:db-types/);
  });

  it("docs/00 no longer claims the DB/RLS suite is not built", () => {
    expect(OVERVIEW).not.toMatch(
      /Full Supabase-local DB integration coverage, an RLS policy suite, and browser E2E coverage are NOT yet built/,
    );
    expect(OVERVIEW).toMatch(/db-integration/);
  });

  // SUPERSEDED PIN (2026-07-27). This test previously required docs/00 to say
  //   "Browser E2E coverage is the piece still NOT built"
  // That is false at the production SHA: playwright.config.ts exists, 44 specs
  // live under e2e/, and .github/workflows/ci.yml runs them as the dedicated
  // `browser-e2e` job (plus a separate `payment-browser-e2e` lane). The guard
  // was forcing a false sentence to stay in the canonical product overview.
  it("docs/00 states browser E2E is shipped, not missing", () => {
    // Negative pins: the stale claims may not return, in any phrasing.
    expect(OVERVIEW).not.toMatch(/Browser E2E coverage is the piece still NOT built/);
    expect(OVERVIEW).not.toMatch(/browser E2E remains deferred/i);
    expect(OVERVIEW).not.toMatch(/[Nn]o browser E2E/);
    expect(OVERVIEW).not.toMatch(/browser E2E coverage all required first/i);
    // AFFIRMATIVE pin: the test name promises a positive claim, so assert one.
    // A bare /browser E2E/i substring would pass on almost any text and would
    // not catch drift; pin the actual sentence and the CI job name.
    expect(OVERVIEW).toMatch(/\*\*Browser E2E is shipped\*\*/);
    expect(OVERVIEW).toMatch(/`browser-e2e` CI job/);
    expect(OVERVIEW).toMatch(/`playwright\.config\.ts`/);
    // Manual smoke stays complementary: synthetic E2E does not replace real
    // provider sends, real Stripe Elements, or real webhook delivery.
    expect(OVERVIEW).toMatch(
      /\*\*Manual smoke \(docs\/12\) remains\s+complementary and is not replaced by synthetic E2E\*\*/,
    );
  });

  it("the browser E2E infrastructure the docs claim actually exists", () => {
    expect(existsSync(path.resolve(__dirname, "../..", "playwright.config.ts"))).toBe(true);
    const specs = readdirSync(path.resolve(__dirname, "../..", "e2e")).filter((f) =>
      f.endsWith(".spec.ts"),
    );
    // Pin the EXACT count the docs advertise, not a floor. If a spec is added or
    // removed, every doc quoting the number must be updated in the same PR.
    expect(specs.length).toBeGreaterThan(0);
    const claimed = new RegExp(`${specs.length} specs under`);
    expect(OVERVIEW).toMatch(claimed);
    expect(SECURITY).toMatch(claimed);
    // CI actually runs it: a config on disk is not coverage.
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^\s{2}browser-e2e:/m);
    expect(ci).toMatch(/npm run test:e2e/);
    // The default lane really does run the whole suite, not one spec.
    expect(read("package.json")).toMatch(/"test:e2e":\s*"playwright test"/);
    expect(read("playwright.config.ts")).toMatch(/testDir:\s*"\.\/e2e"/);
  });

  it("docs/03 reflects the DB lane and the pinned CLI grants-parity rule", () => {
    expect(SECURITY).not.toMatch(/RLS policy suite, and browser E2E coverage remain deferred/);
    expect(SECURITY).toMatch(/Supabase CLI pinned to 2\.102\.0 for grants parity/);
  });
});

describe("product reality acknowledged", () => {
  it("docs/00 names the post-hardening capabilities", () => {
    expect(OVERVIEW).toMatch(/per-client procedure record pulls with filtered print \(PR #223\)/);
    expect(OVERVIEW).toMatch(/exposure incident history is owner-only \(PR #222\)/);
    expect(OVERVIEW).toMatch(/charted within 24h, PR #225/);
    expect(OVERVIEW).toMatch(/internal operator runbook \(docs\/20, PR #224\)/);
  });

  it("docs/00 states the supervised-pilot vs paid-launch line", () => {
    expect(OVERVIEW).toMatch(
      /safe for the supervised Chloe\/Laura pilot[\s\S]{0,90}NOT ready for first paid customers, broad self-serve launch/,
    );
  });

  it("live-payment posture is current across the touched docs (supervised live; still-off items documented)", () => {
    // README no longer claims live is blocked; it states the supervised-live posture + still-off items.
    expect(README).not.toMatch(/Live payments remain blocked/);
    expect(README).toMatch(/live for approved studios/i);
    expect(README).toMatch(/public booking card collection/i);
    // docs/00 payment row reflects the current posture.
    expect(OVERVIEW).toMatch(/\| Live payment \| \*\*Supervised live for approved studios/);
    // docs/11 runbook's manual-review note is now a point-in-time note, not a current "disabled" claim.
    expect(OPS_RUNBOOK).not.toMatch(/Live payments remain disabled; this is operations hardening/);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("README livemode CHECK claim names the canonical ledger", () => {
    expect(README).toMatch(
      /canonical `payment_charge_attempts` ledger \(plus the legacy, read-only `manual_fee_charge_attempts` table\)/,
    );
    expect(README).toMatch(/controlled live payment enablement has not started/);
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
    expect(OVERVIEW).toMatch(/Browser E2E coverage is the piece still NOT built/);
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
      /safe for the supervised Chloe\/Laura pilot; it is NOT ready for first paid customers, broad self-serve launch, or live payments/,
    );
  });

  it("live payments remain disabled, everywhere this PR touched", () => {
    expect(README).toMatch(/Live payments remain blocked/);
    expect(OPS_RUNBOOK).toMatch(/NOT READY FOR LIVE PAYMENTS/);
    expect(OVERVIEW).toMatch(/\| Live payment \| \*\*Not ready/);
  });
});

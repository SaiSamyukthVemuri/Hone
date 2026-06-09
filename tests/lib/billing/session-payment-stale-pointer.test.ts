import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #177. Pin the prepare-gate + execute-gate behavior so a future
// refactor that drops the stale-pointer branch is caught here.

const ELIG_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-eligibility.ts",
);
const ELIG = readFileSync(ELIG_PATH, "utf8");

const CHARGE_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-charge.ts",
);
const CHARGE = readFileSync(CHARGE_PATH, "utf8");

describe("PR #177 prepare gate: stale pointer blocks prepare", () => {
  it("eligibility helper handles the signed_current_but_card_pointer_stale branch", () => {
    expect(ELIG).toMatch(
      /case "signed_current_but_card_pointer_stale":/,
    );
  });

  it("the stale-pointer branch pushes the exact practitioner-facing reason", () => {
    expect(ELIG).toMatch(
      /case "signed_current_but_card_pointer_stale":[\s\S]{0,800}Client must re-sign the current card authorization for the card on file\./,
    );
  });

  it("the stale-pointer branch does NOT set cardAuthSummary (gate fails)", () => {
    // cardAuthSummary is set ONLY in the signed_current branch.
    // The structural shape: cardAuthSummary = { signatureId: ... }
    // appears exactly once in the switch, in the signed_current case.
    const setCalls = ELIG.match(/cardAuthSummary\s*=\s*\{/g) ?? [];
    expect(setCalls.length).toBe(1);
    expect(ELIG).toMatch(
      /case "signed_current":\s*\n\s*cardAuthSummary\s*=\s*\{/,
    );
  });

  it("the eligibility helper still requires cardAuthorization in the truthy gate", () => {
    // The final eligible:true return requires cardAuthSummary not null,
    // so the stale-pointer branch (which doesn't set it) cannot pass.
    expect(ELIG).toMatch(
      /reasons\.length === 0 &&[\s\S]{0,500}cardAuthSummary &&/,
    );
  });
});

describe("PR #177 prepare gate: existing branches still surface their copy", () => {
  it("no_live_template still surfaces 'Card authorization template is not configured.'", () => {
    expect(ELIG).toMatch(/Card authorization template is not configured\./);
  });

  it("unsigned still surfaces 'Card authorization is not signed.'", () => {
    expect(ELIG).toMatch(/Card authorization is not signed\./);
  });

  it("signed_out_of_date still surfaces 'Card authorization on file is out of date.'", () => {
    expect(ELIG).toMatch(/Card authorization on file is out of date\./);
  });
});

describe("PR #177 execute gate: stale pointer blocks execution", () => {
  it("the charge helper handles the stale-pointer kind explicitly", () => {
    expect(CHARGE).toMatch(
      /if \(cardAuth\.kind === "signed_current_but_card_pointer_stale"\)/,
    );
  });

  it("the stale-pointer branch returns outcome='authorization_not_current'", () => {
    expect(CHARGE).toMatch(
      /signed_current_but_card_pointer_stale[\s\S]{0,1000}outcome:\s*"authorization_not_current"/,
    );
  });

  it("the execute message is the exact remedy copy", () => {
    expect(CHARGE).toMatch(
      /signed_current_but_card_pointer_stale[\s\S]{0,1000}message:[\s\S]{0,300}Client must re-sign the current card authorization for the card on file\./,
    );
  });
});

describe("PR #177 execute gate: NO Stripe call on stale pointer", () => {
  it("the stale-pointer return appears BEFORE any paymentIntents.create call", () => {
    const staleIdx = CHARGE.indexOf(
      'cardAuth.kind === "signed_current_but_card_pointer_stale"',
    );
    const piCreateIdx = CHARGE.indexOf("paymentIntents.create");
    expect(staleIdx).toBeGreaterThan(-1);
    expect(piCreateIdx).toBeGreaterThan(-1);
    expect(staleIdx).toBeLessThan(piCreateIdx);
  });
});

describe("PR #177 execute gate: existing recheck assertions preserved", () => {
  it("execute still rechecks cardAuth.signatureId === attemptRow.card_authorization_signature_id", () => {
    expect(CHARGE).toMatch(
      /cardAuth\.signatureId !== attemptRow\.card_authorization_signature_id/,
    );
  });

  it("execute still calls loadCardAndVerifyLineage", () => {
    expect(CHARGE).toMatch(/loadCardAndVerifyLineage\(\{/);
  });

  it("loadCardAndVerifyLineage still compares card.card_authorization_signature_id to expectedSignatureId", () => {
    expect(CHARGE).toMatch(
      /card\.card_authorization_signature_id !== args\.expectedSignatureId/,
    );
  });
});

describe("PR #177 safety gates (PR-scoped negative checks)", () => {
  it("eligibility helper does NOT modify any payment_charge_attempts row", () => {
    expect(ELIG).not.toMatch(
      /\.from\("payment_charge_attempts"\)[\s\S]{0,200}\.update\(|\.from\("payment_charge_attempts"\)[\s\S]{0,200}\.insert\(/,
    );
  });

  it("eligibility helper does NOT call Stripe directly", () => {
    expect(ELIG).not.toMatch(/getStripe\(\)|paymentIntents|setupIntents/);
  });

  it("charge helper does NOT add any NEW paymentIntents.create call site", () => {
    // The existing PR #173 call site lives in the runSessionPaymentCharge
    // body. We confirm there is still EXACTLY ONE call site by counting
    // the substring; the check-stripe-gates.mjs script also enforces a
    // global allowlist count of 2 across the whole runtime tree.
    const matches = CHARGE.match(/paymentIntents\.create\(/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

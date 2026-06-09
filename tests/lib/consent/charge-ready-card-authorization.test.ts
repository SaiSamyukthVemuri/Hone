import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #177. Source-grep tests pin the load-bearing shape of the
// charge-ready helper. It must:
//   * wrap the base getCardAuthorizationStatus (not duplicate it)
//   * add ONLY a card-row pointer check
//   * return a discriminated union that includes every base variant
//     plus the new 'signed_current_but_card_pointer_stale' variant
//   * stay scoped to (studio, client, livemode, status='active',
//     removed_at IS NULL)
//   * NOT be called from portal re-sign or Add Card paths

const HELPER_PATH = path.resolve(
  __dirname,
  "../../../lib/consent/current-card-authorization.ts",
);
const HELPER = readFileSync(HELPER_PATH, "utf8");

const PORTAL_SIGN_PATH = path.resolve(
  __dirname,
  "../../../app/portal/consent-actions.ts",
);
const PORTAL_SIGN = readFileSync(PORTAL_SIGN_PATH, "utf8");

const PORTAL_PAYMENT_METHOD_PATH = path.resolve(
  __dirname,
  "../../../app/portal/payment-method-actions.ts",
);
const PORTAL_PAYMENT_METHOD = readFileSync(PORTAL_PAYMENT_METHOD_PATH, "utf8");

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

const MANUAL_FEE_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/manual-fee-eligibility.ts",
);
const MANUAL_FEE = readFileSync(MANUAL_FEE_PATH, "utf8");

describe("getChargeReadyCardAuthorizationStatus: declared in current-card-authorization.ts", () => {
  it("exports a function with the expected name", () => {
    expect(HELPER).toMatch(
      /export async function getChargeReadyCardAuthorizationStatus\(/,
    );
  });

  it("calls the base getCardAuthorizationStatus internally (not duplicated logic)", () => {
    expect(HELPER).toMatch(
      /const base = await getCardAuthorizationStatus\(args\);/,
    );
  });

  it("returns the base result unchanged for non-signed_current branches", () => {
    // After computing `base`, an early return for `base.kind !== 'signed_current'`
    // sends the original variant straight through.
    expect(HELPER).toMatch(
      /if \(base\.kind !== "signed_current"\)[\s\S]{0,1000}return base;/,
    );
  });

  it("uses inferStripeLivemode to scope the card lookup", () => {
    expect(HELPER).toMatch(/inferStripeLivemode\(\)/);
  });

  it("scopes the card lookup by (studio, client, livemode, active, not-removed)", () => {
    expect(HELPER).toMatch(
      /from\("client_payment_methods"\)[\s\S]{0,800}\.eq\("studio_id", args\.studioId\)[\s\S]{0,800}\.eq\("client_id", args\.clientId\)[\s\S]{0,800}\.eq\("stripe_livemode", livemode\)[\s\S]{0,800}\.eq\("status", "active"\)[\s\S]{0,800}\.is\("removed_at", null\)/,
    );
  });

  it("returns the base result if no active card exists (no card => not this helper's concern)", () => {
    expect(HELPER).toMatch(/if \(!card\)[\s\S]{0,400}return base;/);
  });
});

describe("getChargeReadyCardAuthorizationStatus: discriminated union shape", () => {
  it("declares the existing no_live_template variant", () => {
    expect(HELPER).toMatch(/kind: "no_live_template"/);
  });

  it("declares the existing unsigned variant", () => {
    expect(HELPER).toMatch(/kind: "unsigned"/);
  });

  it("declares the existing signed_out_of_date variant", () => {
    expect(HELPER).toMatch(/kind: "signed_out_of_date"/);
  });

  it("declares the existing signed_current variant", () => {
    expect(HELPER).toMatch(/kind: "signed_current"/);
  });

  it("declares the new signed_current_but_card_pointer_stale variant", () => {
    expect(HELPER).toMatch(/kind: "signed_current_but_card_pointer_stale"/);
  });

  it("the new variant carries the cardId and the stale pointer for debugging", () => {
    expect(HELPER).toMatch(
      /signed_current_but_card_pointer_stale[\s\S]{0,1500}cardId: string[\s\S]{0,500}cardPointerSignatureId: string \| null/,
    );
  });
});

describe("getChargeReadyCardAuthorizationStatus: comparison + return", () => {
  it("returns base when cardPointer === base.signatureId", () => {
    expect(HELPER).toMatch(
      /if \(cardPointer === base\.signatureId\)[\s\S]{0,200}return base;/,
    );
  });

  it("returns the new variant when cardPointer !== base.signatureId", () => {
    expect(HELPER).toMatch(
      /return \{\s*\n?\s*kind: "signed_current_but_card_pointer_stale"/,
    );
  });
});

describe("Caller classification: portal re-sign path must NOT use the charge-ready helper", () => {
  it("app/portal/consent-actions.ts does NOT import the charge-ready helper", () => {
    expect(PORTAL_SIGN).not.toMatch(
      /import \{[^}]*getChargeReadyCardAuthorizationStatus/,
    );
  });

  it("app/portal/consent-actions.ts only calls the refresh helper, not any auth gate", () => {
    // The action checks the visitor-supplied template id and the
    // client row; it must not gate the SIGN action on a stale
    // pointer (deadlock prevention).
    expect(PORTAL_SIGN).not.toMatch(
      /import \{[^}]*getCardAuthorizationStatus/,
    );
    expect(PORTAL_SIGN).toMatch(
      /refreshActiveCardAuthorizationPointersForSignature/,
    );
  });
});

describe("Caller classification: Add Card / Replace Card path must NOT use the charge-ready helper", () => {
  it("app/portal/payment-method-actions.ts still uses the BASE getCardAuthorizationStatus", () => {
    expect(PORTAL_PAYMENT_METHOD).toMatch(/getCardAuthorizationStatus/);
  });

  it("app/portal/payment-method-actions.ts does NOT use the charge-ready helper", () => {
    expect(PORTAL_PAYMENT_METHOD).not.toMatch(
      /getChargeReadyCardAuthorizationStatus/,
    );
  });
});

describe("Caller classification: session payment charge gates DO use the charge-ready helper", () => {
  it("lib/billing/session-payment-eligibility.ts uses the charge-ready helper", () => {
    expect(ELIG).toMatch(/getChargeReadyCardAuthorizationStatus/);
  });

  it("lib/billing/session-payment-eligibility.ts no longer uses the base helper (replaced)", () => {
    expect(ELIG).not.toMatch(/import \{ getCardAuthorizationStatus \}/);
  });

  it("lib/billing/session-payment-charge.ts uses the charge-ready helper at the execute recheck", () => {
    expect(CHARGE).toMatch(/getChargeReadyCardAuthorizationStatus/);
  });

  it("lib/billing/session-payment-charge.ts no longer imports the base helper", () => {
    expect(CHARGE).not.toMatch(/import \{ getCardAuthorizationStatus \}/);
  });
});

describe("Caller classification: manual fee path is intentionally untouched in PR #177", () => {
  it("lib/billing/manual-fee-eligibility.ts does NOT switch to the charge-ready helper", () => {
    // Manual fee already gates on the card row pointer (it loads
    // cardSignatureId from the card row and verifies its
    // template_version). Switching it to the charge-ready helper
    // here would change behavior; PR #177 keeps the manual fee
    // surface unchanged on purpose.
    expect(MANUAL_FEE).not.toMatch(/getChargeReadyCardAuthorizationStatus/);
  });
});

describe("Practitioner-facing message contract", () => {
  it("the eligibility helper surfaces the exact stale-pointer remedy copy", () => {
    expect(ELIG).toMatch(
      /Client must re-sign the current card authorization for the card on file\./,
    );
  });

  it("the charge helper surfaces the same exact remedy copy at execute", () => {
    expect(CHARGE).toMatch(
      /Client must re-sign the current card authorization for the card on file\./,
    );
  });
});

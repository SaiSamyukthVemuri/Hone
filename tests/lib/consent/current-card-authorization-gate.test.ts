import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #170. The current-version signature gate is shared across
// three surfaces: the helper itself, the SetupIntent action, the
// manual fee eligibility helper, the portal UI, and the
// practitioner UI. These source-grep tests pin the contract:
// each surface MUST read the current template version and refuse
// when the signature's stored template_version differs.
//
// Why source-grep: the gate is small per-site (a couple of lines)
// but its absence is the load-bearing readiness risk. A future PR
// that "cleans up" the version comparison would silently accept
// historical "test" signatures again, which is the exact bug PR
// #170 closes.

function readSrc(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
}

const HELPER = readSrc("lib/consent/current-card-authorization.ts");
const SETUP_INTENT_ACTION = readSrc("app/portal/payment-method-actions.ts");
const ELIGIBILITY = readSrc("lib/billing/manual-fee-eligibility.ts");
const PORTAL_PAGE = readSrc("app/portal/page.tsx");
const PAYMENT_METHOD_CARD = readSrc("components/payment-method-card.tsx");
const CLIENT_PROFILE = readSrc("app/(app)/clients/[id]/page.tsx");

describe("getCardAuthorizationStatus helper", () => {
  it("imports 'server-only' to enforce the server boundary", () => {
    expect(HELPER).toMatch(/^import "server-only";/);
  });

  it("returns four discriminated kinds", () => {
    expect(HELPER).toMatch(/kind: "no_live_template"/);
    expect(HELPER).toMatch(/kind: "unsigned"/);
    expect(HELPER).toMatch(/kind: "signed_out_of_date"/);
    expect(HELPER).toMatch(/kind: "signed_current"/);
  });

  it("filters by is_live=true AND status='active' AND form_type='card_authorization'", () => {
    expect(HELPER).toMatch(/\.eq\("is_live",\s*true\)/);
    expect(HELPER).toMatch(/\.eq\("status",\s*"active"\)/);
    expect(HELPER).toMatch(/\.eq\("form_type",\s*"card_authorization"\)/);
  });

  it("compares signature.template_version to the current template version", () => {
    expect(HELPER).toMatch(
      /signature\.template_version\s*!==\s*template\.version/,
    );
  });

  it("selects template_version on the signature lookup", () => {
    expect(HELPER).toMatch(
      /\.select\("id, template_version, signed_at"\)/,
    );
  });

  it("uses createAdminClient (not the RLS client) because the portal session has already resolved the scope", () => {
    expect(HELPER).toMatch(/createAdminClient/);
  });
});

describe("SetupIntent action uses the gate", () => {
  it("imports getCardAuthorizationStatus", () => {
    expect(SETUP_INTENT_ACTION).toMatch(
      /import \{ getCardAuthorizationStatus \} from "@\/lib\/consent\/current-card-authorization"/,
    );
  });

  it("dispatches on the helper's four kinds", () => {
    expect(SETUP_INTENT_ACTION).toMatch(/cardAuth\.kind === "no_live_template"/);
    expect(SETUP_INTENT_ACTION).toMatch(/cardAuth\.kind === "unsigned"/);
    expect(SETUP_INTENT_ACTION).toMatch(/cardAuth\.kind === "signed_out_of_date"/);
  });

  it("returns a dedicated out-of-date error message", () => {
    expect(SETUP_INTENT_ACTION).toMatch(
      /The card-on-file authorization was updated\. Please review and sign the new version before adding a card\./,
    );
  });

  it("no longer accepts ANY prior version (the pre-PR comment was removed)", () => {
    // Pin the negative: a future refactor that re-introduces the
    // "We accept ANY prior version" branch must update this test
    // and have a deliberate conversation.
    expect(SETUP_INTENT_ACTION).not.toMatch(
      /accept ANY prior version/i,
    );
  });
});

describe("manual fee eligibility uses the version gate", () => {
  it("selects template_id and template_version on the signature lookup", () => {
    expect(ELIGIBILITY).toMatch(/template_id,\s*template_version/);
  });

  it("looks up the live template to compare versions", () => {
    expect(ELIGIBILITY).toMatch(
      /\.from\("consent_form_templates"\)[\s\S]{0,500}\.eq\("form_type",\s*"card_authorization"\)/,
    );
  });

  it("surfaces an out-of-date reason when versions differ", () => {
    expect(ELIGIBILITY).toMatch(
      /Card authorization on file is out of date\. Ask the client to open their portal and sign the updated card authorization\./,
    );
  });

  it("surfaces a template-no-longer-live reason when the live template is gone", () => {
    expect(ELIGIBILITY).toMatch(
      /Card authorization template is no longer live/,
    );
  });

  it("the eligibility short-circuit only clears cardAuthorizationSummary when versions match", () => {
    expect(ELIGIBILITY).toMatch(
      /sigRow\.template_version\s*!==\s*liveTemplate\.version/,
    );
  });
});

describe("portal page computes current vs out-of-date state", () => {
  it("derives cardAuthSignedCurrent and cardAuthOutOfDate from the signature summary", () => {
    expect(PORTAL_PAGE).toMatch(/cardAuthSignedCurrent/);
    expect(PORTAL_PAGE).toMatch(/cardAuthOutOfDate/);
  });

  it("compares template_version between signature summary and template", () => {
    expect(PORTAL_PAGE).toMatch(
      /cardAuthSignatureSummary\.template_version\s*===\s*cardAuthTemplate\.version/,
    );
  });

  it("Add Card surface requires cardAuthSignedCurrent, not any signature", () => {
    expect(PORTAL_PAGE).toMatch(
      /showAddCardInNeedsYou[\s\S]{0,200}cardAuthSignedCurrent/,
    );
  });

  it("renders the dedicated 'Card authorization was updated' block", () => {
    expect(PORTAL_PAGE).toMatch(/Card authorization was updated/);
    expect(PORTAL_PAGE).toMatch(/Review updated authorization/);
  });

  it("the unsigned-templates filter includes out-of-date card_authorization", () => {
    expect(PORTAL_PAGE).toMatch(
      /t\.form_type === "card_authorization"[\s\S]{0,200}sig\.template_version !== t\.version/,
    );
  });

  it("the unsigned-templates filter does NOT special-case other form_types", () => {
    // Defense against accidentally forcing every consent re-sign
    // on every edit. Only card_authorization gets the re-sign
    // treatment in v1.
    const filterBlock =
      PORTAL_PAGE.match(/const unsignedConsentTemplates = consentTemplates\.filter[\s\S]{0,800}\}\)\;/)?.[0] ?? "";
    expect(filterBlock).not.toMatch(/treatment_consent/);
    expect(filterBlock).not.toMatch(/photo_consent/);
    expect(filterBlock).not.toMatch(/policy_acknowledgement/);
  });
});

describe("practitioner PaymentMethodCard surfaces out-of-date state", () => {
  it("accepts a cardAuthorizationOutOfDate prop", () => {
    expect(PAYMENT_METHOD_CARD).toMatch(/cardAuthorizationOutOfDate:\s*boolean/);
  });

  it("renders AuthorizationOutOfDateBlock when no active card", () => {
    expect(PAYMENT_METHOD_CARD).toMatch(/function AuthorizationOutOfDateBlock/);
    expect(PAYMENT_METHOD_CARD).toMatch(
      /Card authorization on file is out of date/,
    );
  });

  it("renders AuthorizationOutOfDateWarning alongside active card", () => {
    expect(PAYMENT_METHOD_CARD).toMatch(
      /function AuthorizationOutOfDateWarning/,
    );
    expect(PAYMENT_METHOD_CARD).toMatch(/needs re-signing/i);
  });

  it("the active-card branch renders the warning conditionally", () => {
    expect(PAYMENT_METHOD_CARD).toMatch(
      /\{cardAuthorizationOutOfDate && <AuthorizationOutOfDateWarning/,
    );
  });
});

describe("client profile page computes the prop", () => {
  it("filters card_authorization on is_live=true AND status='active'", () => {
    expect(CLIENT_PROFILE).toMatch(
      /t\.is_live === true[\s\S]{0,80}t\.status === "active"[\s\S]{0,80}t\.form_type === "card_authorization"/,
    );
  });

  it("computes cardAuthorizationOutOfDate via version comparison", () => {
    expect(CLIENT_PROFILE).toMatch(
      /matchingSignature\.template_version !== cardAuthTemplate\.version/,
    );
  });

  it("passes cardAuthorizationOutOfDate to PaymentMethodCard", () => {
    expect(CLIENT_PROFILE).toMatch(
      /cardAuthorizationOutOfDate=\{cardAuthorizationOutOfDate\}/,
    );
  });
});

describe("no payment / live-mode / SMS behavior added by this PR", () => {
  it("manual-fee-charge.ts is unchanged: still exactly 1 paymentIntents.create", () => {
    // We do not touch lib/billing/manual-fee-charge.ts in this PR;
    // mirror the PR #168 gate so a regression is loud.
    const manualFee = readSrc("lib/billing/manual-fee-charge.ts");
    expect(manualFee.match(/paymentIntents\.create/g)?.length).toBe(1);
  });

  it("STRIPE_ALLOW_LIVE_MODE=true string still lives in lib/stripe/server.ts only", () => {
    const stripeServer = readSrc("lib/stripe/server.ts");
    expect(stripeServer.match(/STRIPE_ALLOW_LIVE_MODE=true/g)?.length).toBe(1);
  });

  it("no refunds.create / charges.create / checkout.sessions in any touched file", () => {
    const files = [
      HELPER,
      SETUP_INTENT_ACTION,
      ELIGIBILITY,
      PORTAL_PAGE,
      PAYMENT_METHOD_CARD,
      CLIENT_PROFILE,
    ];
    for (const f of files) {
      expect(f).not.toMatch(/refunds\.create/);
      expect(f).not.toMatch(/charges\.create/);
      expect(f).not.toMatch(/checkout\.sessions/);
    }
  });

  it("no live-mode block or guard was added or removed by this PR", () => {
    // Pin that inferStripeLivemode usage in eligibility is
    // unchanged from PR #168 baseline.
    expect(ELIGIBILITY).toMatch(/inferStripeLivemode\(\)/);
  });
});

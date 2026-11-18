import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #158. Client portal card-authorization guidance. This file pins the
// Add-card gating, the mode-aware no-charge copy, and the read-only /
// no-payment-call boundaries of the surfaces that PR touched.

const PORTAL_PAGE_PATH = path.resolve(
  __dirname,
  "../../../app/portal/page.tsx",
);
const PORTAL_SOURCE = readFileSync(PORTAL_PAGE_PATH, "utf8");

describe("portal gates Add card on a current-version signed authorization", () => {
  it("preserves the original showAddCardInNeedsYou gating shape (still requires signed at current version)", () => {
    // PR #170 tightened the gate from cardAuthSigned (any version)
    // to cardAuthSignedCurrent (matches template.version). Same
    // semantic intent: Add Card only surfaces when the live
    // authorization is signed; PR #170 makes "signed" mean "at
    // the current version."
    expect(PORTAL_SOURCE).toMatch(
      /const showAddCardInNeedsYou\s*=\s*\n?\s*cardAuthTemplate != null &&\s*\n?\s*cardAuthSignedCurrent &&\s*\n?\s*activeCard == null &&\s*\n?\s*publishableKeyResolution\.ok;/,
    );
  });
});

describe("portal Add card block: mode-aware copy and render gate", () => {
  it("no-charge wrapper is mode-aware: blanket promise only in test; live states later authorized charges", () => {
    // Live branch uses the shared LIVE_SAVE_CARD_NOTE (no immediate charge
    // + later authorized studio charges); the blanket promise stays
    // test-branch only.
    expect(PORTAL_SOURCE).toMatch(
      /stripeLivemode\s*\n?\s*\? LIVE_SAVE_CARD_NOTE\s*\n?\s*: "No charge will be made when you add a card\."/,
    );
    expect(PORTAL_SOURCE).toMatch(
      /stripeLivemode\s*\n?\s*\? LIVE_SIGN_CARD_NOTE\s*\n?\s*: "No charge will be made when you sign or when you add a card\."/,
    );
  });

  it("does NOT render the Add card form until cardAuthSigned is true", () => {
    // The Add card form gate must stay tied to cardAuthSigned. A
    // regression that flips the gate or removes cardAuthSigned would
    // re-introduce the bug Chloe reported (clicking Add card with
    // no signature on file, hitting the action error).
    expect(PORTAL_SOURCE).toMatch(
      /showAddCardInNeedsYou && publishableKeyResolution\.ok && \(/,
    );
  });
});

const CARD_COMPONENT_PATH = path.resolve(
  __dirname,
  "../../../components/payment-method-card.tsx",
);
const CARD_SOURCE = readFileSync(CARD_COMPONENT_PATH, "utf8");

describe("practitioner PaymentMethodCard stays read-only", () => {
  it("does not render Charge / Replace / Remove affordances (still read-only per PR #135)", () => {
    // Strip line and block comments before scanning so the PR #135
    // header comment ("no Charge button, no Replace button, no Remove
    // button") does not cause a false positive. The thing we actually
    // care about is the rendered JSX.
    const codeOnly = CARD_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(codeOnly).not.toMatch(/>Charge</);
    expect(codeOnly).not.toMatch(/>Remove card</);
    expect(codeOnly).not.toMatch(/>Replace card</);
  });

  it("does not import the Supabase admin client", () => {
    expect(CARD_SOURCE).not.toMatch(/admin-server|createAdminClient/);
  });
});

const ELIGIBILITY_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/manual-fee-eligibility.ts",
);
const ELIGIBILITY_SOURCE = readFileSync(ELIGIBILITY_PATH, "utf8");

describe("manual fee eligibility moves no money", () => {
  it("no PaymentIntent / charges / refunds / Checkout / live-mode code was added", () => {
    // Stripe gates are enforced separately by scripts/check-stripe-gates.mjs;
    // this is the unit-level mirror so a copy refactor cannot smuggle a
    // dangerous Stripe call past the diff review.
    expect(ELIGIBILITY_SOURCE).not.toMatch(/paymentIntents\.create/);
    expect(ELIGIBILITY_SOURCE).not.toMatch(/charges\.create/);
    expect(ELIGIBILITY_SOURCE).not.toMatch(/refunds\.create/);
    expect(ELIGIBILITY_SOURCE).not.toMatch(/checkout\.sessions/);
    expect(ELIGIBILITY_SOURCE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE=true/);
  });
});

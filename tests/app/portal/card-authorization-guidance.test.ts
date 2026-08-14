import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #158. Client portal card-authorization guidance copy. Chloe's
// smoke test feedback: "I don't know how to add a card. It should
// give you instructions." This file pins the new portal copy +
// gating + deep-link so a future refactor that drops one of the
// pieces is caught by `npm test`.

const PORTAL_PAGE_PATH = path.resolve(
  __dirname,
  "../../../app/portal/page.tsx",
);
const PORTAL_SOURCE = readFileSync(PORTAL_PAGE_PATH, "utf8");

describe("portal gating computes the new card-authorization-needed placeholder", () => {
  it("exposes a showCardAuthorizationNeeded flag", () => {
    // PR #170 refined the predicate from !cardAuthSigned to
    // cardAuthSignatureSummary == null because the gate now
    // distinguishes "never signed" from "signed an old version".
    // The flag name and semantic (true when no signature at all)
    // are preserved.
    expect(PORTAL_SOURCE).toMatch(
      /const showCardAuthorizationNeeded\s*=\s*\n?\s*cardAuthTemplate != null &&\s*\n?\s*cardAuthSignatureSummary == null &&\s*\n?\s*activeCard == null;/,
    );
  });

  it("the flag participates in the Needs you visibility decision", () => {
    // PR #170 added showCardAuthorizationOutOfDate as a sibling
    // clause; the original showCardAuthorizationNeeded must still
    // appear in the disjunction.
    expect(PORTAL_SOURCE).toMatch(
      /const hasNeedsYou =[\s\S]*?\|\| showCardAuthorizationNeeded\b/,
    );
  });

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

describe("portal renders the State B placeholder copy when authorization is unsigned", () => {
  it("uses the heading 'Card authorization needed before adding a card'", () => {
    expect(PORTAL_SOURCE).toContain(
      "Card authorization needed before adding a card",
    );
  });

  it("tells the client to sign the form above", () => {
    expect(PORTAL_SOURCE).toContain(
      "please review",
    );
    expect(PORTAL_SOURCE).toContain("sign the card authorization form above");
  });

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

  it("renders a 'Review card authorization' deep-link to #forms-to-sign", () => {
    // Both pieces must be present: the visible label AND the
    // fragment URL that anchors the unsigned-forms section above.
    expect(PORTAL_SOURCE).toContain("Review card authorization");
    expect(PORTAL_SOURCE).toContain('href="#forms-to-sign"');
  });

  it("the unsigned forms section carries the matching id and scroll-margin", () => {
    expect(PORTAL_SOURCE).toContain('id="forms-to-sign"');
    expect(PORTAL_SOURCE).toContain("scroll-mt-20");
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

describe("portal renders the State C supporting copy in the Add card block", () => {
  it("includes 'You have signed card authorization.' supporting line", () => {
    expect(PORTAL_SOURCE).toContain("You have signed card authorization.");
  });

  it("repeats the no-charge reassurance inside the Add card block", () => {
    // Two occurrences expected: one in the placeholder above, one
    // in the Add card supporting line. The greppable substring is
    // the same in both for consistency.
    const occurrences =
      PORTAL_SOURCE.match(/No charge will be made when you add a card/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

describe("portal State A: no template configured copy", () => {
  it("uses 'Card setup is not available yet:' wording", () => {
    expect(PORTAL_SOURCE).toContain("Card setup is not available yet:");
  });

  it("explains the studio has not enabled online card setup", () => {
    expect(PORTAL_SOURCE).toContain(
      // PR C: exact blocker instead of the false "has not enabled" claim.
      "the studio has not activated its card authorization form",
    );
  });

  it("the old terse 'Card-on-file authorization is not configured yet.' copy is gone", () => {
    expect(PORTAL_SOURCE).not.toContain(
      "Card-on-file authorization is not configured yet.",
    );
  });
});

// ---------------------------------------------------------------------------
// Practitioner-facing PaymentMethodCard renders the matching three
// blocked-state branches with stable headings the practitioner can
// read aloud to the client.
// ---------------------------------------------------------------------------

const CARD_COMPONENT_PATH = path.resolve(
  __dirname,
  "../../../components/payment-method-card.tsx",
);
const CARD_SOURCE = readFileSync(CARD_COMPONENT_PATH, "utf8");

describe("practitioner PaymentMethodCard renders one of four explicit branches", () => {
  it("active card path renders brand/last4/expiry", () => {
    expect(CARD_SOURCE).toContain(
      "Card on file: {activeCard.brand} ending in {activeCard.last4}",
    );
  });

  it("'no template configured' block uses 'Card authorization template not configured'", () => {
    expect(CARD_SOURCE).toContain(
      "Card authorization template not configured",
    );
    expect(CARD_SOURCE).toContain(
      "Activate a card authorization consent template in Settings",
    );
  });

  it("'authorization not signed' block uses the exact heading from the spec", () => {
    expect(CARD_SOURCE).toContain("Card authorization not signed");
    expect(CARD_SOURCE).toContain(
      "This client cannot add a card on file yet because they have not\n        signed the card authorization form.",
    );
  });

  it("'authorization not signed' block tells Chloe what to tell the client", () => {
    expect(CARD_SOURCE).toContain(
      "Ask the client to open\n        their portal and complete Card authorization under Needs you.",
    );
    expect(CARD_SOURCE).toContain(
      // PR C: honest phrasing, signing alone does not guarantee the Add
      // card option (the studio's payment setup must also be complete).
      "Once signed, the Add card option appears in their portal once the studio's payment setup is complete.",
    );
  });

  it("'signed but no card' block uses the calm follow-up copy", () => {
    expect(CARD_SOURCE).toContain(
      "Card authorization signed, but no card is on file yet.",
    );
    expect(CARD_SOURCE).toContain(
      "Ask the client to open the portal and add a card.",
    );
  });

  it("the prior terse 'No card on file.' italic line is gone (replaced by the four-branch render)", () => {
    expect(CARD_SOURCE).not.toMatch(/italic[^"]*">No card on file\./);
  });

  it("accepts the two new gating props", () => {
    expect(CARD_SOURCE).toMatch(
      /cardAuthorizationTemplateExists:\s*boolean/,
    );
    expect(CARD_SOURCE).toMatch(/cardAuthorizationSigned:\s*boolean/);
  });

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

// ---------------------------------------------------------------------------
// Client profile page wires the new props server-side from the same
// data already loaded for ConsentSignaturesCard.
// ---------------------------------------------------------------------------

const CLIENT_PAGE_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/page.tsx",
);
const CLIENT_PAGE_SOURCE = readFileSync(CLIENT_PAGE_PATH, "utf8");

describe("client profile page passes both new gating props to PaymentMethodCard", () => {
  it("passes cardAuthorizationTemplateExists", () => {
    expect(CLIENT_PAGE_SOURCE).toMatch(
      /cardAuthorizationTemplateExists=\{[\s\S]*?cardAuthorizationTemplateExists[\s\S]*?\}/,
    );
  });

  it("passes cardAuthorizationSigned", () => {
    expect(CLIENT_PAGE_SOURCE).toMatch(
      /cardAuthorizationSigned=\{cardAuthorizationSigned\}/,
    );
  });

  it("derives both from existing consentTemplatesAll + consentLatestSignatures (no new DB call)", () => {
    expect(CLIENT_PAGE_SOURCE).toMatch(
      /const cardAuthTemplate = consentTemplatesAll\.find/,
    );
    expect(CLIENT_PAGE_SOURCE).toMatch(
      /const matchingSignature = cardAuthTemplate[\s\S]*?consentLatestSignatures\.find/,
    );
  });
});

// ---------------------------------------------------------------------------
// Manual fee blocked-reason copy now matches the PaymentMethodCard
// "authorization not signed" branch so the practitioner reads the
// same instruction on every surface.
// ---------------------------------------------------------------------------

const ELIGIBILITY_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/manual-fee-eligibility.ts",
);
const ELIGIBILITY_SOURCE = readFileSync(ELIGIBILITY_PATH, "utf8");

describe("manual fee eligibility blocked reasons use the new practitioner-actionable copy", () => {
  it("the 'no card on file' reason now tells Chloe what to ask the client", () => {
    expect(ELIGIBILITY_SOURCE).toContain(
      "Ask the client to open their portal and add a card.",
    );
    expect(ELIGIBILITY_SOURCE).toContain(
      "They must first sign card authorization in the portal",
    );
  });

  it("the 'card lacks signature' reason matches the PaymentMethodCard heading", () => {
    expect(ELIGIBILITY_SOURCE).toContain(
      "Card authorization not signed. The client must sign card authorization in the portal before a card can be added or a manual fee can be prepared.",
    );
  });

  it("the old terse 'Card on file has no signed card authorization.' line is gone", () => {
    expect(ELIGIBILITY_SOURCE).not.toMatch(
      /push\(\s*["']Card on file has no signed card authorization\.["']/,
    );
  });

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

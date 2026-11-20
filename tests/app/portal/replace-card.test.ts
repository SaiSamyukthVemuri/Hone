import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #151: portal Replace card flow.
//
// The Replace card UI reuses the existing SetupIntent flow. The
// server action createCardSetupIntentAction is unchanged; the
// webhook's setup_intent.succeeded handler (PR #135) already pre-
// flips any existing active card on the (studio, client) pair to
// status='removed' before inserting the new active row.
//
// These tests pin down the surface invariants we never want to lose:
//   * The copy carries the test-mode disclaimer / approved live authorization.
//   * The server action requires a portal session and a signed authorization.
//   * Neither the action nor the components call paymentIntents.create,
//     charges.create, refunds.create, or checkout.sessions.

const PORTAL_CARD_COMPONENT = path.resolve(
  __dirname,
  "../../../app/portal/PortalCardOnFileCard.tsx",
);
const PORTAL_CARD_SOURCE = readFileSync(PORTAL_CARD_COMPONENT, "utf8");

const PORTAL_FORM = path.resolve(
  __dirname,
  "../../../app/portal/PortalPaymentMethodForm.tsx",
);
const PORTAL_FORM_SOURCE = readFileSync(PORTAL_FORM, "utf8");
const SHARED_CARD_COPY = readFileSync(
  path.resolve(__dirname, "../../../lib/payments/portal-card-copy.ts"),
  "utf8",
);

const ACTION_FILE = path.resolve(
  __dirname,
  "../../../app/portal/payment-method-actions.ts",
);
const ACTION_SOURCE = readFileSync(ACTION_FILE, "utf8");

describe("portal replace-card surface (PR #151)", () => {
  it("PortalCardOnFileCard surfaces the test-mode disclaimer", () => {
    // The exact disclaimer copy must remain. Future PRs that
    // weaken or remove it (e.g. as part of a live-mode rollout)
    // must update this assertion deliberately.
    // PR C: the disclaimer is centralized in lib/payments/portal-card-copy
    // so the two surfaces cannot drift; both components must render the
    // shared constant, and the constant must keep the exact wording.
    expect(SHARED_CARD_COPY).toMatch(
      /Test mode only\. No live card will be charged\./,
    );
    expect(PORTAL_CARD_SOURCE).toMatch(/\{TEST_MODE_CARD_NOTE\}/);
    // Defensive: do not introduce wording that implies the card
    // WILL be charged (positive claim). The "No live card will
    // be charged" copy above is fine; this assertion catches a
    // future copy regression that drops the "No".
    expect(PORTAL_CARD_SOURCE).not.toMatch(/\byour card will be charged\b/i);
    expect(PORTAL_CARD_SOURCE).not.toMatch(/\bwe will charge\b/i);
  });

  describe("lawyer-approved LIVE authorization copy (2026-07-04)", () => {
    it("card-on-file card shows the approved authorization block in live mode", () => {
      expect(PORTAL_CARD_SOURCE).toMatch(/Card-on-file authorization/);
      expect(PORTAL_CARD_SOURCE).toMatch(
        /By saving a payment card on file, you authorize \{studio\}/,
      );
      expect(PORTAL_CARD_SOURCE).toMatch(/no-show fees;/);
      expect(PORTAL_CARD_SOURCE).toMatch(/late-cancellation fees;/);
      expect(PORTAL_CARD_SOURCE).toMatch(
        /not[\s\S]{0,40}the treatment provider or merchant of record/,
      );
      expect(PORTAL_CARD_SOURCE).toMatch(
        /You may contact \{studio\} with any questions about charges, refunds/,
      );
      // Interpolates the real studio name (safe fallback) + gated on livemode.
      expect(PORTAL_CARD_SOURCE).toMatch(/studioName/);
      expect(PORTAL_CARD_SOURCE).toMatch(/livemode \?/);
    });

    it("replace-card form shows the approved replace authorization in live mode", () => {
      expect(PORTAL_FORM_SOURCE).toMatch(
        /Saving a new card will replace the current card on file for \$\{studio\}/,
      );
      expect(PORTAL_FORM_SOURCE).toMatch(
        /you authorize \$\{studio\} to charge it for amounts you have agreed to pay/,
      );
      expect(PORTAL_FORM_SOURCE).toMatch(/studioName/);
    });

    it("preserves the mode-gated test-mode warning (shared constant)", () => {
      expect(PORTAL_CARD_SOURCE).toMatch(/TEST_MODE_CARD_NOTE/);
      expect(PORTAL_FORM_SOURCE).toMatch(/TEST_MODE_CARD_NOTE/);
      expect(SHARED_CARD_COPY).toMatch(/Test mode only/);
    });
  });

  it("portal payment-method action requires a portal session", () => {
    // The server action's identity guard is the contract that keeps
    // an unauthenticated caller from triggering a SetupIntent. Pin
    // it down as a textual assertion against the action file.
    expect(ACTION_SOURCE).toMatch(/getCurrentPortalSession\(/);
  });

  it("portal payment-method action refuses archived clients", () => {
    // The action selects archived_at on the clients row and rejects
    // when it is not null. This is the only place "archived" needs
    // to be honored on this surface (a still-live cookie on an
    // archived client cannot start a SetupIntent).
    expect(ACTION_SOURCE).toMatch(/archived_at/);
    expect(ACTION_SOURCE).toMatch(/archived_at != null|archived_at !== null/);
  });

  it("portal payment-method action passes card_authorization_signature_id to the SetupIntent", () => {
    // PR #170 moved the signature lookup into the shared
    // getCardAuthorizationStatus helper, so the action reads the
    // signature id from the helper's return shape
    // (cardAuth.signatureId) instead of an inline `signature.id`
    // alias.
    expect(ACTION_SOURCE).toMatch(
      /cardAuthorizationSignatureId:\s*(signature\.id|cardAuth\.signatureId)/,
    );
  });

  it("portal payment-method action does NOT call paymentIntents.create, charges.create, refunds.create, or checkout.sessions", () => {
    expect(ACTION_SOURCE).not.toMatch(/paymentIntents\.create/);
    expect(ACTION_SOURCE).not.toMatch(/charges\.create/);
    expect(ACTION_SOURCE).not.toMatch(/refunds\.create/);
    expect(ACTION_SOURCE).not.toMatch(/checkout\.sessions/);
  });

  it("PortalPaymentMethodForm does NOT call paymentIntents/charges/refunds directly", () => {
    expect(PORTAL_FORM_SOURCE).not.toMatch(/paymentIntents\.create/);
    expect(PORTAL_FORM_SOURCE).not.toMatch(/charges\.create/);
    expect(PORTAL_FORM_SOURCE).not.toMatch(/refunds\.create/);
    expect(PORTAL_FORM_SOURCE).not.toMatch(/checkout\.sessions/);
  });

  it("PortalCardOnFileCard does NOT call paymentIntents/charges/refunds directly", () => {
    expect(PORTAL_CARD_SOURCE).not.toMatch(/paymentIntents\.create/);
    expect(PORTAL_CARD_SOURCE).not.toMatch(/charges\.create/);
    expect(PORTAL_CARD_SOURCE).not.toMatch(/refunds\.create/);
    expect(PORTAL_CARD_SOURCE).not.toMatch(/checkout\.sessions/);
  });
});

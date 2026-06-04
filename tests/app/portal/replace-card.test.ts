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
//   * The portal page renders "Replace card" wording when a client
//     has an active card.
//   * The portal renders the read-only "Add card on file" wording
//     where appropriate (Needs you uses the form's add-mode copy).
//   * The new client component derives the toggle locally; it does
//     not introduce any new payment-moving call.
//   * The server action file does not call paymentIntents.create,
//     charges.create, refunds.create, or checkout.sessions.

const PORTAL_PAGE = path.resolve(
  __dirname,
  "../../../app/portal/page.tsx",
);
const PORTAL_PAGE_SOURCE = readFileSync(PORTAL_PAGE, "utf8");

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

const ACTION_FILE = path.resolve(
  __dirname,
  "../../../app/portal/payment-method-actions.ts",
);
const ACTION_SOURCE = readFileSync(ACTION_FILE, "utf8");

describe("portal replace-card surface (PR #151)", () => {
  it("portal page wires PortalCardOnFileCard when active card exists", () => {
    expect(PORTAL_PAGE_SOURCE).toMatch(/import\s+\{\s*PortalCardOnFileCard\s*\}/);
    expect(PORTAL_PAGE_SOURCE).toMatch(/<PortalCardOnFileCard/);
  });

  it("PortalCardOnFileCard renders 'Replace card' button text", () => {
    expect(PORTAL_CARD_SOURCE).toMatch(/Replace card/);
  });

  it("PortalCardOnFileCard surfaces the test-mode disclaimer", () => {
    // The exact disclaimer copy must remain. Future PRs that
    // weaken or remove it (e.g. as part of a live-mode rollout)
    // must update this assertion deliberately.
    expect(PORTAL_CARD_SOURCE).toMatch(
      /Test mode only\. No live card will be charged\./,
    );
    // Defensive: do not introduce wording that implies the card
    // WILL be charged (positive claim). The "No live card will
    // be charged" copy above is fine; this assertion catches a
    // future copy regression that drops the "No".
    expect(PORTAL_CARD_SOURCE).not.toMatch(/\byour card will be charged\b/i);
    expect(PORTAL_CARD_SOURCE).not.toMatch(/\bwe will charge\b/i);
  });

  it("PortalPaymentMethodForm carries mode-conditional copy for Add vs Replace", () => {
    expect(PORTAL_FORM_SOURCE).toMatch(/idleButton: "Add card on file"/);
    expect(PORTAL_FORM_SOURCE).toMatch(/idleButton: "Replace card"/);
    expect(PORTAL_FORM_SOURCE).toMatch(/saveButton: "Save card on file"/);
    expect(PORTAL_FORM_SOURCE).toMatch(/saveButton: "Save new card"/);
  });

  it("Replace mode copy says current card will be replaced and no charge", () => {
    expect(PORTAL_FORM_SOURCE).toMatch(
      /current card will be replaced after the new card is saved/,
    );
    expect(PORTAL_FORM_SOURCE).toMatch(/No charge will be made/);
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
    expect(ACTION_SOURCE).toMatch(/cardAuthorizationSignatureId:\s*signature\.id/);
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

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

// PR #152: Replace card now auto-starts the SetupIntent fetch on
// mount so the visitor sees exactly one "Replace card" click before
// Stripe Elements appears. The double-button bug was caused by the
// inner form re-rendering its own idle "Replace card" button.
describe("portal replace-card auto-start (PR #152)", () => {
  it("PortalCardOnFileCard passes autoStart to PortalPaymentMethodForm in replace mode", () => {
    // We accept either the shorthand `autoStart` or the explicit
    // `autoStart={true}` JSX form.
    expect(PORTAL_CARD_SOURCE).toMatch(/<PortalPaymentMethodForm[\s\S]*?autoStart[\s\S]*?\/>/);
    expect(PORTAL_CARD_SOURCE).toMatch(/mode="replace"/);
  });

  it("PortalPaymentMethodForm declares an autoStart prop with a sensible default", () => {
    expect(PORTAL_FORM_SOURCE).toMatch(/autoStart\?\s*:\s*boolean/);
    expect(PORTAL_FORM_SOURCE).toMatch(/autoStart\s*=\s*false/);
  });

  it("PortalPaymentMethodForm guards auto-start against double-fire (useRef)", () => {
    // Strict Mode runs effects twice in dev; the ref is the
    // contract that prevents two SetupIntents.
    expect(PORTAL_FORM_SOURCE).toMatch(/autoStartedRef\s*=\s*useRef/);
    expect(PORTAL_FORM_SOURCE).toMatch(/autoStartedRef\.current/);
  });

  it("PortalPaymentMethodForm exposes the 'Preparing secure card form...' loading copy", () => {
    expect(PORTAL_FORM_SOURCE).toMatch(/Preparing secure card form\.\.\./);
  });

  it("PortalPaymentMethodForm exposes the start-failure copy", () => {
    expect(PORTAL_FORM_SOURCE).toMatch(
      /We could not open the secure card form\. Please try again\./,
    );
  });

  it("Add mode default is autoStart=false (the existing manual click stays)", () => {
    // The default in the function signature is `autoStart = false`,
    // and the Needs You add-card mount does NOT pass the prop.
    expect(PORTAL_PAGE_SOURCE).toMatch(/<PortalPaymentMethodForm[\s\S]*?publishableKey=/);
    // The Add usage in the portal page must not pass autoStart.
    const addMatch = PORTAL_PAGE_SOURCE.match(
      /<PortalPaymentMethodForm[\s\S]*?publishableKey=\{[^}]+\}[\s\S]*?\/>/,
    );
    expect(addMatch).not.toBeNull();
    // The Add card surface in /portal page uses the bare form without
    // mode=replace or autoStart. Verify there is no autoStart in the
    // Add mount specifically.
    const addBlock = addMatch?.[0] ?? "";
    expect(addBlock).not.toMatch(/autoStart/);
    expect(addBlock).not.toMatch(/mode="replace"/);
  });
});

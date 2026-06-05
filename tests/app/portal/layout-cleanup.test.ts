import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #159. Portal layout cleanup. Chloe's smoke test surfaced:
//   * "The portal's just a little cluttered looking."
//   * "It doesn't really make sense to show them the signed forms
//      if they can't click on it and see what they signed."
//   * "I think the care instructions should be toggled open
//      automatically."
//   * "The email me button should be at the top."
//   * "Change 'Your info' to your appointments / upcoming
//      appointments."
//
// This file pins each of those changes textually so a future
// refactor that reverts one of them is caught by `npm test`. The
// tests deliberately do NOT assert against the PR #158 card-
// authorization guidance copy (that has its own test file); they
// only cover what PR #159 added or reorganized.

const PORTAL_PATH = path.resolve(
  __dirname,
  "../../../app/portal/page.tsx",
);
const SOURCE = readFileSync(PORTAL_PATH, "utf8");

// ---------------------------------------------------------------------------
// Header: contact-the-studio button now lives in the top-right
// cluster next to Sign out. Bottom "Need help?" section is gone.
// ---------------------------------------------------------------------------

describe("header now carries the Email <studio> contact action", () => {
  it("renders an Email button gated on contactHref in the header cluster", () => {
    // The header is the first top-level child after the page main.
    // We pin the relative ordering: the contactHref block must
    // appear ABOVE the portalLogoutAction form, both inside the
    // header div.
    const headerBlock =
      SOURCE.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(headerBlock).toMatch(/\{contactHref && \(/);
    expect(headerBlock).toMatch(/Email \{studio\.name\}/);
    expect(headerBlock).toMatch(/<form action=\{portalLogoutAction\}>/);
    // Order: contactHref appears before the logout form
    const contactIdx = headerBlock.indexOf("{contactHref &&");
    const logoutIdx = headerBlock.indexOf("portalLogoutAction");
    expect(contactIdx).toBeGreaterThan(-1);
    expect(logoutIdx).toBeGreaterThan(contactIdx);
  });

  it("the legacy bottom 'Need help?' heading is gone", () => {
    // The previous footer carried <h3>Need help?</h3>. The new
    // header-level button replaces it; no duplicate at the bottom.
    // We pin the heading shape specifically so commentary that
    // mentions the prior block (now documenting the removal) does
    // not trigger a false positive.
    expect(SOURCE).not.toMatch(/<h3[^>]*>\s*Need help\?\s*</);
  });

  it("the legacy 'Email <studio>' button at the bottom of Your info is gone", () => {
    // The only occurrence of the Email button now lives inside the
    // <header> cluster. Count the regex occurrences.
    const occurrences =
      SOURCE.match(/Email \{studio\.name\}/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Section headings: the "Your info" wrapper is split into three
// top-level sections with explicit headings (Appointments / Care
// instructions / Forms and records / Payment method). The first
// three carry an h2 heading; the legacy heading is gone.
// ---------------------------------------------------------------------------

describe("section headings reflect the new top-level structure", () => {
  it("the legacy 'Your info' h2 is gone", () => {
    expect(SOURCE).not.toMatch(/>\s*Your info\s*</);
  });

  it("Appointments has an h2 heading", () => {
    expect(SOURCE).toMatch(/<h2[^>]*>\s*Appointments\s*</);
  });

  it("Care instructions has an h2 heading (promoted out of Your info)", () => {
    expect(SOURCE).toMatch(/<h2[^>]*>\s*Care instructions\s*</);
  });

  it("Forms and records has an h2 heading", () => {
    expect(SOURCE).toMatch(/<h2[^>]*>\s*Forms and records\s*</);
  });

  it("the legacy 'Signed forms' h3 is replaced by 'Completed forms'", () => {
    expect(SOURCE).not.toMatch(/>\s*Signed forms\s*</);
    expect(SOURCE).toMatch(/<h3[^>]*>\s*Completed forms\s*</);
  });

  it("the Needs you section is still present and unchanged", () => {
    // PR #159 must not break the existing Needs you wiring.
    expect(SOURCE).toMatch(/>\s*Needs you\s*</);
    expect(SOURCE).toMatch(/\{hasNeedsYou \?/);
  });
});

// ---------------------------------------------------------------------------
// Care instructions: now <details open> by default. Chloe's
// feedback: "I think the care instructions should be toggled open
// automatically." We pin the open attribute so a future refactor
// cannot silently re-collapse it.
// ---------------------------------------------------------------------------

describe("care instructions are open by default", () => {
  it("the care-instructions <details> carries the open attribute", () => {
    expect(SOURCE).toMatch(/<details open className="flex flex-col gap-2">/);
  });

  it("only one <details> wraps the care content (no legacy duplicate)", () => {
    // A regression here would suggest a refactor reintroduced the
    // collapsed-by-default block. The Section grouping pre-care +
    // postcare under a SINGLE details open is the contract.
    const careHeadingOccurrences =
      SOURCE.match(/>\s*Care instructions\s*</g) ?? [];
    // One occurrence in the new h2; the inner summary uses
    // "Review these before and after your appointment."
    expect(careHeadingOccurrences.length).toBe(1);
  });

  it("the inner summary reads 'Review these before and after your appointment.'", () => {
    expect(SOURCE).toContain(
      "Review these before and after your appointment.",
    );
  });
});

// ---------------------------------------------------------------------------
// Completed forms (formerly "Signed forms"): styled as a record
// list, not as actionable cards. The caption verb is now "Completed"
// for non-photo-consent rows.
// ---------------------------------------------------------------------------

describe("completed forms render as quiet records, not actionable cards", () => {
  it("non-photo rows use 'Completed ' as the caption prefix", () => {
    // The previous code used "Signed " for the non-photo branch.
    // Pin the new verb.
    expect(SOURCE).toMatch(/:\s*"Completed ";/);
    expect(SOURCE).not.toMatch(/:\s*"Signed ";/);
  });

  it("rows drop the heavy bordered card style and use a soft border-top divider list", () => {
    // The previous row used border:1px solid + bg:#FAFAF7 PER ROW
    // (felt like clickable cards). The new shape uses border-t
    // dividers and inherits the section background, so the list
    // reads as quiet history.
    const completedFormsBlock =
      SOURCE.match(
        /\{signedConsentTemplates\.length > 0 && \(([\s\S]*?)\)\}/,
      )?.[1] ?? "";
    expect(completedFormsBlock).toMatch(/border-t py-3/);
    // Sanity check: the heavy per-row border + filled background is
    // not in this block any more.
    expect(completedFormsBlock).not.toMatch(
      /backgroundColor:\s*"#FAFAF7"[\s\S]{0,200}border:\s*"1px solid #E5E2D9"/,
    );
  });

  it("a footnote sets expectations honestly: a viewable copy is coming soon", () => {
    expect(SOURCE).toContain(
      "A viewable copy of signed forms is coming soon.",
    );
  });

  it("title rows lost the bold weight (no longer reads as a button label)", () => {
    // We deliberately switched the title paragraph from
    // text-[14px] font-medium -> text-[14px] (no font-medium).
    // A future refactor that re-applies font-medium on the title
    // should be a conscious choice; this assertion catches the
    // accidental case.
    const completedFormsBlock =
      SOURCE.match(
        /\{signedConsentTemplates\.length > 0 && \(([\s\S]*?)\)\}/,
      )?.[1] ?? "";
    expect(completedFormsBlock).not.toMatch(
      /\{t\.title\}[\s\S]{0,300}font-medium/,
    );
  });
});

// ---------------------------------------------------------------------------
// PR #158 card-authorization guidance must STILL be present. PR
// #159 cannot regress the placeholder, the deep-link anchor, the
// signed-supporting line, or the Add card gate.
// ---------------------------------------------------------------------------

describe("PR #158 card-authorization guidance is preserved", () => {
  it("the Card authorization needed placeholder still renders", () => {
    expect(SOURCE).toContain(
      "Card authorization needed before adding a card",
    );
  });

  it("the deep-link button + #forms-to-sign anchor both still exist", () => {
    expect(SOURCE).toContain('href="#forms-to-sign"');
    expect(SOURCE).toContain('id="forms-to-sign"');
  });

  it("the State C supporting line in the Add card block still exists", () => {
    expect(SOURCE).toContain("You have signed card authorization.");
  });

  it("the Add card form is still gated on cardAuthSigned + publishable key ok", () => {
    expect(SOURCE).toMatch(
      /showAddCardInNeedsYou && publishableKeyResolution\.ok && \(/,
    );
  });

  it("the State A 'card setup not available' wording still exists", () => {
    expect(SOURCE).toContain("Card setup is not available yet.");
  });
});

// ---------------------------------------------------------------------------
// No payment / Stripe behavior added by this PR. Mirror of the
// Stripe gates at the unit level so a copy refactor cannot smuggle
// a dangerous call through.
// ---------------------------------------------------------------------------

describe("no payment behavior added", () => {
  it("portal page does not call PaymentIntent / Charge / Refund / Checkout / live-mode", () => {
    expect(SOURCE).not.toMatch(/paymentIntents\.create/);
    expect(SOURCE).not.toMatch(/charges\.create/);
    expect(SOURCE).not.toMatch(/refunds\.create/);
    expect(SOURCE).not.toMatch(/checkout\.sessions/);
    expect(SOURCE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE=true/);
  });

  it("portal page does not import the Supabase admin client", () => {
    expect(SOURCE).not.toMatch(/admin-server|createAdminClient/);
  });
});

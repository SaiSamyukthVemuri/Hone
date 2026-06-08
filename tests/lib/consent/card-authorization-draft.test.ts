import { describe, expect, it } from "vitest";
import {
  CARD_AUTHORIZATION_DRAFT_V1_TITLE,
  CARD_AUTHORIZATION_DRAFT_V1_BODY,
  CARD_AUTHORIZATION_DRAFT_V1_BODY_LENGTH,
} from "@/lib/consent/card-authorization-draft";

// PR #170. The product-ready DRAFT body for the card_authorization
// consent template. The DRAFT replaces the literal "test"
// placeholder (4 chars) currently in production for both Willow
// Electrolysis and the developer "My Studio" row. The DRAFT must
// cover seven topic areas per the PR #170 spec, while avoiding
// three risky phrasings. These tests pin each contract.
//
// These tests intentionally do NOT claim legal approval. The body
// is the DRAFT presented for legal review. The header comment in
// lib/consent/card-authorization-draft.ts is explicit about that
// boundary, and the legal review track is PR #170-followup
// (Chloe + counsel review and either accept the draft or edit it
// via Settings -> Consent forms, which bumps the version through
// the existing updateConsentTemplateAction).

describe("CARD_AUTHORIZATION_DRAFT_V1_TITLE", () => {
  it("is the product-ready title, not 'test'", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_TITLE).toBe("Card on file authorization");
    expect(CARD_AUTHORIZATION_DRAFT_V1_TITLE).not.toBe("test");
  });

  it("is short enough to satisfy the DB CHECK on title length", () => {
    // consent_form_templates CHECK: 1 <= char_length(title) <= 160.
    expect(CARD_AUTHORIZATION_DRAFT_V1_TITLE.length).toBeGreaterThanOrEqual(1);
    expect(CARD_AUTHORIZATION_DRAFT_V1_TITLE.length).toBeLessThanOrEqual(160);
  });
});

describe("CARD_AUTHORIZATION_DRAFT_V1_BODY: required coverage", () => {
  // 1. Card on file
  it("covers Card on file (Stripe, no full PAN/CVC, replaceable)", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/Card on file/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/Stripe/);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(
      /do not store my full card number/i,
    );
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/security code/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/replace this card/i);
  });

  // 2. Completed-session off-session charges
  it("covers off-session completed-session charges", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(
      /Charges for completed sessions/i,
    );
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/off-session charge/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(
      /confirmed by the practitioner/i,
    );
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/actual treatment/i);
  });

  // 3. Late cancellation fees
  it("covers late cancellation fees with policy reference", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/Late cancellation fees/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/cancellation policy/i);
  });

  // 4. No-show fees
  it("covers no-show fees with policy reference", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/No-show fees/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/no-show policy/i);
  });

  // 5. Receipts, refunds, disputes (no chargeback waiver)
  it("covers receipts, refunds, disputes at a high level", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(
      /Receipts, refunds, and disputes/i,
    );
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/refund policy/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/chargeback/i);
  });

  // 6. Payment processing and privacy
  it("covers payment processing + privacy", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(
      /Payment processing and privacy/i,
    );
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/PCI-compliant/);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/privacy policy/i);
  });

  // 7. Scope and revocation
  it("covers scope and revocation", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/Scope and revocation/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/replace the card/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/remove the card/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/revoke this authorization/i);
  });
});

describe("CARD_AUTHORIZATION_DRAFT_V1_BODY: risk avoidance", () => {
  it("does NOT contain a chargeback waiver", () => {
    // Avoid "you waive all chargeback rights" or similar.
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(
      /waive[^.]{0,40}chargeback/i,
    );
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(
      /forfeit[^.]{0,40}chargeback/i,
    );
    // Affirmatively preserves dispute rights.
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(
      /does not waive my dispute rights/i,
    );
  });

  it("does NOT contain unbounded charge language", () => {
    // Avoid "we may charge any amount at any time".
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(
      /any amount[\s\S]{0,40}any time/i,
    );
  });

  it("does NOT contain blanket non-refundable language", () => {
    // Avoid "non-refundable under all circumstances".
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(
      /non-refundable[\s\S]{0,40}all circumstances/i,
    );
  });

  it("does NOT contain unresolved {{ }} placeholders", () => {
    // The body must not ship to production with handlebars-style
    // placeholders if no template engine renders them.
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("does NOT claim legal approval", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(/legally approved/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(
      /reviewed by counsel/i,
    );
  });
});

describe("CARD_AUTHORIZATION_DRAFT_V1_BODY: length + format", () => {
  it("satisfies the consent_form_templates.body CHECK (1 to 20000 chars)", () => {
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY_LENGTH).toBeGreaterThanOrEqual(1);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY_LENGTH).toBeLessThanOrEqual(20000);
  });

  it("is substantially longer than the prior 'test' placeholder", () => {
    // Sanity check: the production body was 4 chars (\"test\"). The
    // draft must be meaningfully longer to count as a real
    // consent document.
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY_LENGTH).toBeGreaterThan(1000);
  });

  it("is studio-agnostic (no hardcoded studio names)", () => {
    // The draft should refer to "this studio" / "the studio's
    // policy" rather than naming Willow or any other studio.
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(/Willow/i);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).not.toMatch(/My Studio/);
    expect(CARD_AUTHORIZATION_DRAFT_V1_BODY).toMatch(/this studio/i);
  });
});

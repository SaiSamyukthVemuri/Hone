import "server-only";

// PR #170. Product-ready DRAFT wording for the card_authorization
// consent template body. Replaces Willow's literal "test"
// placeholder (body_chars = 4) confirmed in production by the
// PR #168 audit + the PR #170 audit (2026-06-08).
//
// This is the v1 DRAFT. It is NOT legally approved. Chloe + legal
// counsel must review the body before flipping any live-mode flag.
// The Hone codebase does not validate the body text against
// required phrases (and should not -- the legal wording is the
// studio's responsibility, not Hone's). This constant is the
// "what we shipped to production as the v1 draft" reference;
// future edits by a studio owner via Settings -> Consent forms
// edit the database row directly and bump the version (the
// updateConsentTemplateAction sets version = existing.version + 1
// on every save), at which point this constant becomes a stale
// historical reference. That is intentional -- the database is
// the source of truth; this constant is the audit trail.
//
// IMPORTANT: the "this is a draft / not yet legally approved"
// posture lives in THIS comment block, in docs/05, docs/13,
// docs/14, and docs/16. It MUST NOT leak into the body string
// the client signs. A client-facing authorization that tells the
// client "this form may still need legal review before live
// charges" undermines the trust the form is trying to establish
// and is the wrong place to flag the legal status. The body
// below was patched (post initial PR #170 commit) to strip the
// disclaimer sentence and any "software provider" references
// that placed Hone's role in front of the client; the test in
// tests/lib/consent/card-authorization-draft.test.ts pins the
// negative so a future re-draft cannot re-introduce the
// disclaimer accidentally.
//
// Coverage (the v1 draft must address ALL of the following per
// PR #170 spec, and the tests in
// tests/lib/consent/card-authorization-draft.test.ts pin each):
//
//   1. Card on file (Stripe stores card; Hone/studio do not store
//      full PAN or CVC; card can be replaced or removed).
//   2. Completed-session off-session charges (practitioner-confirmed
//      amount; charge after appointment ends; receipt to client).
//   3. Late cancellation fees (per studio's cancellation policy).
//   4. No-show fees (per studio's no-show policy).
//   5. Receipts, refunds, disputes (high level; no chargeback waiver).
//   6. Payment processing and privacy (Stripe is the processor;
//      record retention; studio privacy policy).
//   7. Scope and revocation (saved card; until replaced / removed /
//      revoked in writing).
//
// Risk avoidance (the draft DELIBERATELY does NOT contain):
//   - "you waive all chargeback rights" or similar chargeback
//     waiver language (chargeback rights are statutory and the
//     studio's posture is that they will defend with evidence,
//     not that the client agreed to forfeit the right).
//   - "we may charge any amount at any time" (the practitioner-
//     confirmed amount and the policy reference are the bounds).
//   - "non-refundable under all circumstances" (refunds follow
//     the studio's refund policy, not a blanket no-refund line).
//
// Studio-agnostic phrasing: the body refers to "this studio" and
// "the studio's policy" rather than naming Willow specifically.
// The portal renders the studio name in the header (PR #159);
// the consent body is generic so the same draft applies to every
// studio that consumes Hone. Concrete policy amounts are NOT
// inlined here because the studio configures them in Settings
// (studios.late_cancel_fee_cents, studios.no_show_fee_cents,
// studios.cancellation_policy_text, studios.no_show_policy_text)
// and the policy acknowledgement surface (PR #132 / migration
// 0056) is the legally-relevant point at which the client sees
// the exact figures at cancel / no-show time.

export const CARD_AUTHORIZATION_DRAFT_V1_TITLE = "Card on file authorization";

export const CARD_AUTHORIZATION_DRAFT_V1_BODY = `Card on file authorization

By signing below, I am giving this studio permission to keep my payment card on file and to charge that card for treatment, late cancellations, and missed appointments under the terms below.

1. Card on file

I authorize this studio to save my payment card securely on file. The card is stored through Stripe, the studio's payment processor. The studio and Hone do not store my full card number or security code; only the brand, last four digits, and expiry date are kept for reference. I can replace this card or ask the studio to remove it at any time.

2. Charges for completed sessions

I authorize this studio to charge my saved card for treatment after a completed appointment or session. The amount is confirmed by the practitioner based on the actual treatment that was delivered. The charge may happen after the appointment ends, without my card being entered again at that moment (an off-session charge). I will receive a receipt by email after a charge succeeds.

3. Late cancellation fees

I have read this studio's cancellation policy. If I cancel inside the window described in that policy, I authorize the studio to charge my saved card the cancellation fee described in the policy. The studio will follow the policy that was in effect when I booked the appointment.

4. No-show fees

If I do not attend a scheduled appointment, I authorize the studio to charge my saved card the no-show fee described in this studio's no-show policy.

5. Receipts, refunds, and disputes

Each successful charge generates a receipt. If I have a question about a charge, I will contact the studio first. Refunds are handled according to the studio's refund policy. Card-issuer disputes (chargebacks) remain my right; signing this authorization does not waive my dispute rights with my card issuer.

6. Payment processing and privacy

Card details are processed by Stripe, a PCI-compliant payment processor. Hone and the studio do not store my full card number or security code. The studio retains transaction records (date, amount, last four digits, reason for the charge) for accounting, dispute response, and audit purposes. The studio handles my information according to its privacy policy.

7. Scope and revocation

This authorization applies to the card I save with this studio under this signature. It applies until: (a) I replace the card with a different one and the studio confirms the replacement on file, (b) I ask the studio to remove the card from file, or (c) I revoke this authorization in writing to the studio.

By signing, I confirm that I have read and agree to the above. I confirm that I am the cardholder or am authorized to use this card.`;

// Length sanity. The consent_form_templates body CHECK is
// 1 <= char_length(body) <= 20000 (migration 0057 line 51).
// The draft is around 2.5 kB so well inside the limit; we pin
// the size at test time to catch a silent truncation if the
// constant is ever rebuilt from a smaller source.
export const CARD_AUTHORIZATION_DRAFT_V1_BODY_LENGTH =
  CARD_AUTHORIZATION_DRAFT_V1_BODY.length;

// Shared portal card-on-file wrapper copy (PR C). Client-safe constants —
// NO server-only import — used by both PortalCardOnFileCard and
// PortalPaymentMethodForm so the test-mode note cannot drift, and by the
// portal page for the mode-aware no-immediate-charge wrappers.
//
// These are NON-LEGAL wrapper strings. The lawyer-approved authorization
// texts (PortalCardOnFileCard live block, PortalPaymentMethodForm live
// replace intro, the receipt template) are pinned elsewhere and are NEVER
// sourced from here.

// Test-mode note (shared verbatim by the card summary + the replace form).
export const TEST_MODE_CARD_NOTE =
  "Test mode only. No live card will be charged.";

// Live-mode wrapper: truthful "no immediate charge" plus the equally
// truthful "later authorized charges may occur" — a live client must never
// read an unqualified blanket no-charge promise on the surface that stores
// a chargeable card.
export const LIVE_SAVE_CARD_NOTE =
  "No charge is made at the moment you add a card. Once saved, the studio may charge this card for amounts you have authorized under the signed card authorization (such as approved appointment charges, no-show fees, or late-cancellation fees).";

export const LIVE_SIGN_CARD_NOTE =
  "Signing itself does not charge you, and no charge is made at the moment you add a card. Once a card is saved, the studio may charge it for amounts you have authorized under the card authorization.";

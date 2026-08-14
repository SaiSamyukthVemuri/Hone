import "server-only";

// Server-side LIVE charge-reason allowlist (launch hard hold).
//
// For this launch, LIVE-mode charging is restricted to session payments only.
// Manual no-show / late-cancellation fee charging is on a HARD HOLD in live
// mode until it is explicitly enabled in a future PR: enforced server-side
// (prepare AND execute), never UI-only. TEST mode is unaffected: every reason
// is allowed so existing manual-fee testing keeps working.
//
// This module changes NO charge/refund/webhook execution and adds NO Stripe
// SDK calls or DB writes. It is a pure predicate + the user-facing message.

export const LIVE_MANUAL_FEE_HOLD_MESSAGE =
  "Live cancellation and no-show fee charging is on hold for this launch. Use session payments only unless manual fees are explicitly approved.";

// Charge reasons permitted to prepare/execute in LIVE mode right now.
// session_payment is allowed; the manual-fee reasons are held.
const LIVE_ALLOWED_CHARGE_REASONS = new Set<string>(["session_payment"]);

export function isChargeReasonAllowedInLive(chargeReason: string): boolean {
  return LIVE_ALLOWED_CHARGE_REASONS.has(chargeReason);
}

// Returns the user-facing hold message if this (reason, mode) is blocked, or
// null if it is allowed. In TEST mode nothing is blocked (returns null); in
// LIVE mode, only session_payment is allowed and every other reason returns
// the hold message.
export function liveChargeReasonBlockMessage(
  chargeReason: string,
  livemode: boolean,
): string | null {
  if (!livemode) return null;
  if (isChargeReasonAllowedInLive(chargeReason)) return null;
  return LIVE_MANUAL_FEE_HOLD_MESSAGE;
}

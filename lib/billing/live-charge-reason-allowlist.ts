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

// The two manual-fee reasons. They are held in LIVE mode EXCEPT for studios named
// in the server-side allowlist below. Nothing else (a future reason) is ever opened
// by it.
const MANUAL_FEE_CHARGE_REASONS = new Set<string>(["no_show_fee", "late_cancellation_fee"]);

// Per-studio live enablement for the two manual fees (route (a): no migration).
// A server-side environment variable holding a comma-separated list of studio ids.
// The DEFAULT IS EMPTY, so with the variable unset, blank or malformed every fee
// stays held, exactly as before. It is read at call time, on the server only, and
// is never exposed to the browser (the name has no NEXT_PUBLIC_ prefix). A studio id
// is never written in a repo file: it lives only in the deployment environment, and
// only on the operator's per-studio written approval.
export const MANUAL_FEE_LIVE_STUDIOS_ENV = "HONE_MANUAL_FEE_LIVE_STUDIO_IDS";

const STUDIO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Strict parse. Any token that is not a plain UUID is DROPPED (never matched as a
// prefix, a wildcard or a name), so a typo can only shrink the list. Whole-string
// garbage yields the empty set.
export function parseManualFeeLiveStudios(raw: string | undefined | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (typeof raw !== "string") return out;
  for (const token of raw.split(",")) {
    const id = token.trim().toLowerCase();
    if (STUDIO_ID_PATTERN.test(id)) out.add(id);
  }
  return out;
}

export function isManualFeeLiveEnabledForStudio(
  studioId: string | null | undefined,
  rawEnv: string | undefined | null = process.env[MANUAL_FEE_LIVE_STUDIOS_ENV],
): boolean {
  if (typeof studioId !== "string") return false;
  return parseManualFeeLiveStudios(rawEnv).has(studioId.trim().toLowerCase());
}

export function isChargeReasonAllowedInLive(chargeReason: string, studioId?: string | null): boolean {
  if (LIVE_ALLOWED_CHARGE_REASONS.has(chargeReason)) return true;
  if (!MANUAL_FEE_CHARGE_REASONS.has(chargeReason)) return false;
  return isManualFeeLiveEnabledForStudio(studioId);
}

// Returns the user-facing hold message if this (reason, mode, studio) is blocked,
// or null if it is allowed. In TEST mode nothing is blocked (returns null); in LIVE
// mode session_payment is allowed, a manual fee is allowed ONLY for an allowlisted
// studio, and every other reason returns the hold message. Called with no studio
// id (the old two-argument form) a manual fee is blocked, so an old call site can
// only be stricter, never looser.
export function liveChargeReasonBlockMessage(
  chargeReason: string,
  livemode: boolean,
  studioId?: string | null,
): string | null {
  if (!livemode) return null;
  if (isChargeReasonAllowedInLive(chargeReason, studioId)) return null;
  return LIVE_MANUAL_FEE_HOLD_MESSAGE;
}

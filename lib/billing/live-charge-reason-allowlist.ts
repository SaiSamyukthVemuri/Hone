import "server-only";

// Cancellation fees are available to every studio after owner tier setup and enablement (0357).
// No-show fees retain their separate per-studio rollout control. Unknown charge reasons fail closed.
// These release predicates do not replace the owner, current policy, card or attempt guards.

export const LIVE_MANUAL_FEE_HOLD_MESSAGE =
  "Live charging for this fee type has not been released for this studio.";

// Charge reasons permitted to prepare/execute in LIVE mode right now.
// session_payment is allowed; the manual-fee reasons are held.
const LIVE_ALLOWED_CHARGE_REASONS = new Set<string>(["session_payment"]);

// Legacy late-cancellation environment values no longer govern availability. No-show retains its own list.
const MANUAL_FEE_CHARGE_REASONS = new Set<string>(["no_show_fee", "late_cancellation_fee"]);
export const LATE_CANCEL_FEE_LIVE_STUDIOS_ENV = "HONE_LATE_CANCEL_FEE_LIVE_STUDIO_IDS";
export const NO_SHOW_FEE_LIVE_STUDIOS_ENV = "HONE_NO_SHOW_FEE_LIVE_STUDIO_IDS";

// The earlier single variable opened BOTH fees at once. It is no longer read by
// anything: a stale value left in a deployment opens NOTHING. The name is kept here
// only so a test can prove that.
export const LEGACY_MANUAL_FEE_LIVE_STUDIOS_ENV = "HONE_MANUAL_FEE_LIVE_STUDIO_IDS";

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

// The variable that governs one reason, or null for a reason with no list.
function liveStudiosEnvNameFor(chargeReason: string): string | null {
  if (chargeReason === "late_cancellation_fee") return LATE_CANCEL_FEE_LIVE_STUDIOS_ENV;
  if (chargeReason === "no_show_fee") return NO_SHOW_FEE_LIVE_STUDIOS_ENV;
  return null;
}

// True only when THIS reason's own list names the studio. `rawEnv` is for tests; in
// production it is the reason's own variable, read now.
export function isManualFeeLiveEnabledForStudio(
  chargeReason: string,
  studioId: string | null | undefined,
  rawEnv?: string | undefined | null,
): boolean {
  if (typeof studioId !== "string") return false;
  const name = liveStudiosEnvNameFor(chargeReason);
  if (name === null) return false;
  const raw = rawEnv === undefined ? process.env[name] : rawEnv;
  return parseManualFeeLiveStudios(raw).has(studioId.trim().toLowerCase());
}

export function isChargeReasonAllowedInLive(chargeReason: string, studioId?: string | null): boolean {
  // Cancellation fees are self-service for every studio. The governed tier configuration,
  // owner enablement, policy, card authorization and payment readiness still apply at prepare/execute.
  if (chargeReason === "late_cancellation_fee") return true;
  if (LIVE_ALLOWED_CHARGE_REASONS.has(chargeReason)) return true;
  if (!MANUAL_FEE_CHARGE_REASONS.has(chargeReason)) return false;
  return isManualFeeLiveEnabledForStudio(chargeReason, studioId);
}

// Returns the user-facing hold message if this (reason, mode, studio) is blocked,
// or null if it is allowed. In TEST mode nothing is blocked (returns null); in LIVE
// mode session_payment is allowed, a manual fee is allowed ONLY for a studio on
// THAT reason's own allowlist, and every other reason returns the hold message. Called with no studio
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

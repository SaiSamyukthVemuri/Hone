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

// The two manual-fee reasons. They are held in LIVE mode EXCEPT for studios named in
// the per-reason server-side allowlist for THAT reason. Nothing else (a future
// reason) is ever opened by either list.
const MANUAL_FEE_CHARGE_REASONS = new Set<string>(["no_show_fee", "late_cancellation_fee"]);

// Per-studio, PER-REASON live enablement (route (a): no migration). Each list is a
// server-side environment variable holding comma-separated studio ids, and each opens
// ONLY its own reason:
//   HONE_LATE_CANCEL_FEE_LIVE_STUDIO_IDS -> late_cancellation_fee only
//   HONE_NO_SHOW_FEE_LIVE_STUDIO_IDS     -> no_show_fee only
// The DEFAULT IS EMPTY, so with a variable unset, blank or malformed that fee stays
// held. Read at call time, on the server only, never exposed to the browser (no
// NEXT_PUBLIC_ prefix). A studio id is never written in a repo file: it lives only in
// the deployment environment, on the operator's per-studio written approval.
//
// TEMPORARY RELEASE CONTROL, not the studio-facing feature. The studio-facing switch is the owner's own setting
// (studios.late_cancel_fee_enabled / no_show_fee_enabled, 0351, lib/billing/manual-fee-studio-setting.ts). In LIVE mode a
// fee needs BOTH that setting ON and the studio in that reason's list here; in TEST mode only the setting applies.
// For EACH fee type separately, its list is removed only when ALL of these hold (OPS, per Sam, 15 Nov 2026):
//   (a) the settings migration (0351) is applied and read back;
//   (b) the readiness of that type has been reviewed (Insurance, and Privacy for the wording);
//   (c) its tests pass, including the test-mode smoke for that type;
//   (d) monitoring is in place for stuck or unclear fee attempts;
//   (e) Sam gives explicit rollout approval, in his own words.
// There is NO minimum number of days or of real charged fees: a real fee is never created to satisfy a testing count.
// Removal is a PR that deletes that type's release check here, after which the owner's setting plus payment readiness
// alone govern. First responder for a stuck or unclear attempt: OPS; Stripe investigation escalates to Sam.
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

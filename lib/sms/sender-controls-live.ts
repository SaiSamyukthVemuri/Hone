import "server-only";
import { liveProvisioningArmed, resolveProvisioningProvider } from "./provider";
import type { SmsProvisioningProvider } from "./provider/types";
import { outboundSmsFence } from "./twilio";
import { classifyNanpNumber } from "./nanp";

// ===========================================================================
// SMS-SENDER-LIVE-GATE-01 (HON-50 G1 + G3): the LIVE mode of the owner's
// sender controls, and the owner's confirmation before anything is bought.
// ===========================================================================
//
// SHIPS CLOSED. Nothing in code, config or seed lists a studio, so this mode
// opens nowhere until an operator deliberately sets ALL of:
//
//   HONE_SMS_SENDER_CONTROLS = "live"
//   HONE_SMS_SENDER_CONTROLS_LIVE_STUDIO_IDS = "<studio uuid>[,<uuid>…]"
//   HONE_SMS_PROVISIONING_LIVE = "true" + the Twilio credentials (provider/index.ts)
//
// and then only:
//   * on the PRODUCTION deployment (VERCEL_ENV=production). A preview uses the
//     production database and a local run has no business renting numbers;
//   * where the outbound SMS fence allows sending (lib/sms/twilio.ts), because
//     provisioning and adoption end with one test text;
//   * for a studio on the allowlist. A malformed list opens nothing.
//
// This module is the ONLY path from the controls to the real adapter. The
// fake mode (lib/sms/sender-controls.ts) is unchanged and still never resolves
// a provider.
// ===========================================================================

export const SENDER_CONTROLS_LIVE_STUDIOS_ENV = "HONE_SMS_SENDER_CONTROLS_LIVE_STUDIO_IDS";

type Env = Readonly<Record<string, string | undefined>>;

export type LiveGateRefusal =
  | "live_not_production"
  | "live_outbound_fenced"
  | "live_not_armed"
  | "live_not_allowlisted";

export type LiveGate = { open: true; mode: "live" } | { open: false; reason: LiveGateRefusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The operator's allowlist. FAIL CLOSED: an unset or blank value, or ANY entry
 * that is not a UUID, yields the empty set, so a typo can never be read as
 * "everyone" or as a partial list the operator did not mean.
 */
export function liveStudioAllowlist(env: Env = process.env): ReadonlySet<string> {
  const raw = env[SENDER_CONTROLS_LIVE_STUDIOS_ENV]?.trim();
  if (!raw) return new Set();
  const ids = raw.split(",").map((s) => s.trim().toLowerCase());
  if (ids.some((id) => !UUID.test(id))) return new Set();
  return new Set(ids);
}

/** The live branch of senderControlsGate, for ONE studio. */
export function liveGateFor(
  env: Env,
  studioId: string | null | undefined,
  liveArmed: () => boolean = liveProvisioningArmed,
): LiveGate {
  if (env.VERCEL_ENV !== "production") return { open: false, reason: "live_not_production" };
  if (!outboundSmsFence(env as NodeJS.ProcessEnv).allowed) return { open: false, reason: "live_outbound_fenced" };
  if (!liveArmed()) return { open: false, reason: "live_not_armed" };
  if (!studioId || !liveStudioAllowlist(env).has(studioId.toLowerCase())) {
    return { open: false, reason: "live_not_allowlisted" };
  }
  return { open: true, mode: "live" };
}

/**
 * The real adapter, for an action whose gate answered `live`. Re-checks the
 * arming itself: a caller that reached here without it gets an exception, not
 * the fake, so a live-mode request can never quietly write fake records.
 */
export function liveSenderControlsProvider(
  liveArmed: () => boolean = liveProvisioningArmed,
): SmsProvisioningProvider {
  if (!liveArmed()) throw new Error("sender controls: live provider requested while live provisioning is not armed");
  return resolveProvisioningProvider();
}

// ---------------------------------------------------------------------------
// G3: no purchase without the owner's confirmation, checked on the SERVER.
// ---------------------------------------------------------------------------
//
// The confirmation is bound to ONE number: `confirm_number` must equal the
// number being bought, so a confirmation given for one candidate cannot be
// replayed for another, and a direct action call without it is refused before
// any provider is constructed. In live mode the owner also names the phone
// that receives the one test text and agrees to it: Hone never texts a number
// it invented.

export type ConfirmationRefusal =
  | "purchase_not_confirmed"
  | "confirmation_number_mismatch"
  | "test_text_not_confirmed"
  | "test_destination_invalid";

export type PurchaseConfirmation =
  | { ok: true; testDestination: string | null }
  | { ok: false; reason: ConfirmationRefusal };

/** A NANP mobile-range number the owner can receive a text on (CA or US). */
function usableTestDestination(raw: string): string | null {
  const c = classifyNanpNumber(raw.trim());
  return c.ok && (c.country === "CA" || c.country === "US") ? c.e164 : null;
}

export function checkPurchaseConfirmation(input: {
  mode: "fake" | "live";
  phoneNumber: string;
  confirmNumber: string;
  confirmCost: string;
  testDestination: string;
  confirmTestText: string;
}): PurchaseConfirmation {
  if (input.confirmCost !== "yes") return { ok: false, reason: "purchase_not_confirmed" };
  if (!input.phoneNumber || input.confirmNumber !== input.phoneNumber) {
    return { ok: false, reason: "confirmation_number_mismatch" };
  }
  if (input.mode === "fake") return { ok: true, testDestination: null };
  return checkLiveTestText(input);
}

/** Live adoption buys nothing, but it still sends one test text. */
export function checkLiveTestText(input: {
  testDestination: string;
  confirmTestText: string;
}): PurchaseConfirmation {
  if (input.confirmTestText !== "yes") return { ok: false, reason: "test_text_not_confirmed" };
  const to = usableTestDestination(input.testDestination);
  if (!to) return { ok: false, reason: "test_destination_invalid" };
  return { ok: true, testDestination: to };
}

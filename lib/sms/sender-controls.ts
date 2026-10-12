import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveProvisioningArmed } from "./provider";
import type { SmsProvisioningProvider, AvailableNumberCandidate } from "./provider/types";
import {
  provisionStudioSmsSender,
  searchAvailableSenderNumbers,
  type ProvisionOutcome,
} from "./provisioning";
import { adoptExistingStudioSmsSender, type AdoptionOutcome } from "./adoption";
import { createProvisioningStore } from "./provisioning-store";
import { SMS_STATUS_CALLBACK_PATH } from "./delivery-ledger";

// ===========================================================================
// SMS-SENDER-CONTROL-01 (#824): the studio owner's controls over the 0191
// sender lifecycle -- search a number, provision it, or adopt an existing one
// -- wired to the EXISTING orchestration (provisionStudioSmsSender,
// adoptExistingStudioSmsSender), which until now had no caller.
//
// THIS SLICE NEVER SPENDS MONEY AND NEVER TOUCHES A REAL PROVIDER. The gate
// below opens ONLY for an explicit fake mode:
//
//   HONE_SMS_SENDER_CONTROLS = "fake"   set deliberately, in a test or a
//                                       local/preview demo; unset everywhere else
//
// and it stays shut, whatever that variable says, when either is true:
//
//   * live provisioning is ARMED (HONE_SMS_PROVISIONING_LIVE + credentials):
//     the resolver would hand back the real provider, so a click could buy a
//     number. Refused.
//   * the deployment is PRODUCTION (VERCEL_ENV=production): with live unarmed
//     the resolver returns the FAKE there too, so an unguarded control would
//     write a fake "active" sender into the production database. Refused.
//
// The provider the operations use is therefore always the fake, and it is
// passed in explicitly rather than resolved, so nothing here can reach the
// Twilio adapter. Live provisioning, number purchase and US registration
// submission are separate, owner-approved release decisions.
//
// AUTHORITY: the claim inside both orchestrations re-derives membership and
// owner role from (studio_id, actor_user_id) in the database. The actions add
// the page's owner check on top; neither trusts a browser-supplied studio.
// ===========================================================================

export const SENDER_CONTROLS_ENV = "HONE_SMS_SENDER_CONTROLS";

type Env = Readonly<Record<string, string | undefined>>;

export type SenderControlsGate =
  | { open: true; mode: "fake" }
  | { open: false; reason: "not_enabled" | "live_provisioning_armed" | "production" };

export function senderControlsGate(
  env: Env = process.env,
  liveArmed: () => boolean = liveProvisioningArmed,
): SenderControlsGate {
  if (env.VERCEL_ENV === "production") return { open: false, reason: "production" };
  if (liveArmed()) return { open: false, reason: "live_provisioning_armed" };
  if (env[SENDER_CONTROLS_ENV] !== "fake") return { open: false, reason: "not_enabled" };
  return { open: true, mode: "fake" };
}

/** Countries a studio may request a number in: the CA/US scope of #824. */
export const SENDER_COUNTRIES = ["CA", "US"] as const;
export type SenderCountry = (typeof SENDER_COUNTRIES)[number];

export function isSenderCountry(value: unknown): value is SenderCountry {
  return typeof value === "string" && (SENDER_COUNTRIES as readonly string[]).includes(value);
}

export type SenderControlsDeps = {
  admin: SupabaseClient;
  /** Always a fake in this slice; passed explicitly, never resolved here. */
  provider: SmsProvisioningProvider;
  appOrigin: string;
  /** Where the provisioning proof text goes: an operator destination, never a client. */
  testDestination: string;
};

export type SearchResult =
  | { ok: true; candidates: Array<Pick<AvailableNumberCandidate, "phoneNumber" | "formatted" | "locality" | "region" | "country">> }
  | { ok: false; reason: string };

export async function runSenderSearch(
  deps: Pick<SenderControlsDeps, "provider">,
  input: { country: string; areaCode: string | null },
): Promise<SearchResult> {
  if (!isSenderCountry(input.country)) return { ok: false, reason: "invalid_input" };
  const out = await searchAvailableSenderNumbers({
    provider: deps.provider,
    country: input.country,
    areaCode: input.areaCode,
  });
  if (!out.ok) return { ok: false, reason: out.reason };
  // Only the safe candidate shape crosses back to the browser.
  return {
    ok: true,
    candidates: out.candidates.map((c) => ({
      phoneNumber: c.phoneNumber,
      formatted: c.formatted,
      locality: c.locality,
      region: c.region,
      country: c.country,
    })),
  };
}

function urls(appOrigin: string) {
  const origin = appOrigin.replace(/\/+$/, "");
  return {
    inbound: `${origin}/api/twilio/inbound-sms`,
    status: `${origin}${SMS_STATUS_CALLBACK_PATH}`,
  };
}

export async function runSenderProvision(
  deps: SenderControlsDeps,
  input: { studioId: string; actorUserId: string; country: string; areaCode: string | null; phoneNumber: string },
): Promise<ProvisionOutcome> {
  if (!isSenderCountry(input.country)) return { ok: false, result: "refused", reason: "invalid_input" };
  const u = urls(deps.appOrigin);
  return provisionStudioSmsSender({
    store: createProvisioningStore(deps.admin),
    provider: deps.provider,
    studioId: input.studioId,
    actorUserId: input.actorUserId,
    country: input.country,
    areaCode: input.areaCode,
    phoneNumber: input.phoneNumber,
    inboundWebhookUrl: u.inbound,
    statusCallbackUrl: u.status,
    testDestination: deps.testDestination,
    // A label, not client data.
    serviceLabel: `Hone studio sender ${input.studioId.slice(0, 8)}`,
    testBody: "Hone provisioning test.",
  });
}

export async function runSenderAdoption(
  deps: SenderControlsDeps,
  input: { studioId: string; actorUserId: string; country: string; phoneNumber: string; messagingServiceSid: string },
): Promise<AdoptionOutcome> {
  if (!isSenderCountry(input.country)) return { ok: false, result: "refused", reason: "invalid_input" };
  const u = urls(deps.appOrigin);
  return adoptExistingStudioSmsSender({
    store: createProvisioningStore(deps.admin),
    provider: deps.provider,
    studioId: input.studioId,
    actorUserId: input.actorUserId,
    country: input.country,
    phoneNumber: input.phoneNumber,
    messagingServiceSid: input.messagingServiceSid,
    requiredInboundWebhookUrl: u.inbound,
    requiredStatusCallbackUrl: u.status,
    testDestination: deps.testDestination,
    testBody: "Hone provisioning test.",
  });
}

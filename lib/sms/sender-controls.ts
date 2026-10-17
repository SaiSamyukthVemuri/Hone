import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveProvisioningArmed, FakeSmsProvisioningProvider } from "./provider";
import { classifyNanpNumber } from "./nanp";
import { DEMO_CANDIDATES, demoAdoptionInventory, demoOwnedNumbers, demoOwnedServices, type DemoAdoptionInventory } from "./sender-controls-demo";

export { demoAdoptionInventory };
import type { SmsProvisioningProvider, AvailableNumberCandidate } from "./provider/types";
import {
  provisionStudioSmsSender,
  searchAvailableSenderNumbers,
  type ProvisionOutcome,
} from "./provisioning";
import { adoptExistingStudioSmsSender, type AdoptionOutcome } from "./adoption";
import { createProvisioningStore } from "./provisioning-store";
import { SMS_STATUS_CALLBACK_PATH } from "./delivery-ledger";
import { sameTwilioWebhook, twilioWebhookUrl } from "./webhook-base";
import { inboundReaches } from "./inbound-routing";

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
//                                       local demo; unset everywhere else
//
// and it stays shut, whatever that variable says, when any of these is true:
//
//   * live provisioning is ARMED (HONE_SMS_PROVISIONING_LIVE + credentials):
//     the resolver would hand back the real provider, so a click could buy a
//     number. Refused.
//   * the deployment is PRODUCTION (VERCEL_ENV=production): with live unarmed
//     the resolver returns the FAKE there too, so an unguarded control would
//     write a fake "active" sender into the production database. Refused.
//   * the deployment is ANY OTHER HOSTED Vercel environment (preview): previews
//     use the production database. Refused (Codex P1 4251747841).
//   * the run is not explicitly LOCAL (Codex P2 4266736587): a deployed
//     platform's markers (VERCEL=1, AWS_*), or a database URL that is not the
//     loopback stack. A self-hosted `next start` in production, or a `next dev`
//     pointed at the hosted project, is refused; NODE_ENV is not the
//     authority, the database the fake would write to is.
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
  | {
      open: false;
      reason:
        | "not_enabled"
        | "live_provisioning_armed"
        | "production"
        | "hosted_deployment"
        | "deployed_runtime"
        | "not_local_database";
    };

/**
 * Is this the LOCAL stack? The controls write fake senders through the
 * service-role client to whatever database NEXT_PUBLIC_SUPABASE_URL names, so
 * that URL is the authority on whether a fake record could land anywhere real.
 * Loopback only; anything else (a hosted project, a LAN host, a missing or
 * malformed URL) is not local.
 */
function isLoopbackDatabase(raw: string | undefined): boolean {
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

export function senderControlsGate(
  env: Env = process.env,
  liveArmed: () => boolean = liveProvisioningArmed,
): SenderControlsGate {
  if (env.VERCEL_ENV === "production") return { open: false, reason: "production" };
  // PREVIEWS TOO (Codex P1 4251747841): Vercel previews run against the
  // PRODUCTION database (docs/08), so a fake sender written there would be a
  // fake "active" production record. Only an unhosted run (no VERCEL_ENV) or
  // Vercel's local development environment may open these controls.
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "development") return { open: false, reason: "hosted_deployment" };
  // NOT ONLY VERCEL (Codex P2 4266736587): a self-hosted production runtime
  // (`next start` with NODE_ENV=production and no VERCEL_ENV), or a deployed
  // platform's own markers, must not open these either. The run must be
  // explicitly LOCAL: no deployed-runtime marker, and the database it would
  // write to is the loopback stack. This also shuts a `next dev` pointed at a
  // hosted project, whatever NODE_ENV says.
  if (env.VERCEL === "1" || env.AWS_REGION || env.AWS_EXECUTION_ENV) return { open: false, reason: "deployed_runtime" };
  if (!isLoopbackDatabase(env.NEXT_PUBLIC_SUPABASE_URL)) return { open: false, reason: "not_local_database" };
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

// ---------------------------------------------------------------------------
// The number must belong to the country chosen (Codex P2 4250699105)
// ---------------------------------------------------------------------------
// A studio choosing "United States" must never end up with a Canadian number
// recorded as US (or the reverse): the readiness model and every later send
// rule read that country. The existing NANP classifier decides, BEFORE any
// claim is taken. Toll-free and other-NANP numbers are not studio sender
// numbers in this flow.

/** Does this +1 number (or this area code) belong to `country`? */
export function numberMatchesCountry(phoneNumber: string, country: SenderCountry): boolean {
  const n = classifyNanpNumber(phoneNumber);
  return n.ok && n.country === country;
}

/**
 * Refused before any claim: the number or area code is another country's, or
 * the number is not in the area code the owner searched.
 */
export type CountryRefusal = { ok: false; result: "refused"; reason: "number_country_mismatch" | "area_code_mismatch" };

/**
 * Refused before any claim because the adoption could not be shown to be
 * possible (Codex P2 4250699100, 4250840773). `uncertain` = the provider did
 * not give a complete answer (retry later); otherwise the submission is wrong.
 * Nothing is written either way.
 */
export type PreClaimRefusal = {
  ok: false;
  result: "refused";
  reason:
    | "number_not_owned_by_account"
    | "provider_number_mismatch"
    | "number_in_other_service"
    | "number_not_in_named_service"
    | "number_association_ambiguous"
    | "number_association_unavailable"
    | "service_webhooks_mismatch"
    | "inbound_routing_unknown"
    | "resource_already_recorded"
    | "recorded_check_unavailable"
    | "ownership_unverified";
  uncertain: boolean;
};

export function areaCodeMatchesCountry(areaCode: string, country: SenderCountry): boolean {
  return /^[2-9][0-9]{2}$/.test(areaCode) && numberMatchesCountry(`+1${areaCode}2000000`, country);
}

// ---------------------------------------------------------------------------
// The fake account this surface demonstrates (Codex P2 4250699100)
// ---------------------------------------------------------------------------
// Adoption takes a number the provider ACCOUNT already owns. The process-wide
// fake owns nothing, so every adoption through the panel would fail after
// taking the durable claim. The controls therefore use their OWN fake, seeded
// with one Canadian and one US number held in one demo Messaging Service wired
// to this app's own webhook URLs: adoption can succeed, and search and
// purchase never offer or buy those numbers (the fake treats owned numbers as
// taken). Synthetic 555-01xx numbers; nothing here is a real account.

const controlsFakes = new Map<string, FakeSmsProvisioningProvider>();

/**
 * The seeded fake for ONE studio and one webhook base: that studio's own demo
 * numbers and Messaging Service (Codex P2 4251747847), wired to the URLs built
 * by the same rule as everything Hone configures.
 */
export function senderControlsFakeProvider(
  appOrigin: string,
  studioId: string,
  env: Env = process.env,
): FakeSmsProvisioningProvider {
  const u = urls(appOrigin, env) ?? { inbound: null, status: null };
  const key = `${studioId}|${u.inbound}|${u.status}`;
  let fake = controlsFakes.get(key);
  if (!fake) {
    // The account owns EVERY candidate pair (Codex P2 4274756044), so whichever
    // one resolveDemoInventory advertises can be adopted.
    // ...and one Messaging Service per candidate, holding that candidate's
    // two numbers (Codex P2 4275860500).
    fake = new FakeSmsProvisioningProvider({
      preOwnedNumbers: demoOwnedNumbers(studioId),
      accountServices: demoOwnedServices(studioId).map((svc) => ({
        sid: svc.sid,
        numbers: svc.numbers,
        inboundUrl: u.inbound,
        statusUrl: u.status,
      })),
    });
    controlsFakes.set(key, fake);
  }
  return fake;
}

/**
 * The demo pair this studio's page should advertise: its first candidate whose
 * numbers AND service no row records outside this studio's live attempt (0226
 * studio_sms_resource_recorded, which counts released history too, including
 * this studio's own; Codex P2 4274756044, 4275860500). A read only; if it cannot answer,
 * candidate 0 is shown and the adoption's own pre-claim check still refuses a
 * number another studio holds.
 */
export async function resolveDemoInventory(admin: SupabaseClient, studioId: string): Promise<DemoAdoptionInventory> {
  for (let i = 0; i < DEMO_CANDIDATES; i += 1) {
    const inv = demoAdoptionInventory(studioId, i);
    const ca = await resourceRecorded(admin, studioId, inv.numbers.CA.phoneNumber, null);
    const us = await resourceRecorded(admin, studioId, inv.numbers.US.phoneNumber, null);
    const svc = await resourceRecorded(admin, studioId, null, inv.messagingServiceSid);
    if (ca === null || us === null || svc === null) return demoAdoptionInventory(studioId, 0);
    if (!ca && !us && !svc) return inv;
  }
  return demoAdoptionInventory(studioId, 0);
}

export type SenderControlsDeps = {
  admin: SupabaseClient;
  /** Always a fake in this slice; passed explicitly, never resolved here. */
  provider: SmsProvisioningProvider;
  appOrigin: string;
  /** Where the provisioning proof text goes: an operator destination, never a client. */
  testDestination: string;
  /** The environment the webhook base is read from. Defaults to process.env. */
  env?: Env;
};

export type SearchResult =
  | {
      ok: true;
      /**
       * The validated area code this search used, or null. Carried into every
       * candidate's provisioning form so the claim records the owner's actual
       * request (Codex P2 4253781002).
       */
      areaCode: string | null;
      candidates: Array<Pick<AvailableNumberCandidate, "phoneNumber" | "formatted" | "locality" | "region" | "country">>;
    }
  | { ok: false; reason: string };

export async function runSenderSearch(
  deps: Pick<SenderControlsDeps, "provider">,
  input: { country: string; areaCode: string | null },
): Promise<SearchResult> {
  if (!isSenderCountry(input.country)) return { ok: false, reason: "invalid_input" };
  if (input.areaCode && !areaCodeMatchesCountry(input.areaCode, input.country)) {
    return { ok: false, reason: "area_code_country_mismatch" };
  }
  const out = await searchAvailableSenderNumbers({
    provider: deps.provider,
    country: input.country,
    areaCode: input.areaCode,
  });
  if (!out.ok) return { ok: false, reason: out.reason };
  // Only the safe candidate shape crosses back to the browser.
  return {
    ok: true,
    areaCode: input.areaCode,
    // Only numbers of the chosen country are ever offered.
    candidates: out.candidates.filter((c) => numberMatchesCountry(c.phoneNumber, input.country as SenderCountry)).map((c) => ({
      phoneNumber: c.phoneNumber,
      formatted: c.formatted,
      locality: c.locality,
      region: c.region,
      country: c.country,
    })),
  };
}

/**
 * The webhook URLs to configure and to require, built by the SAME base rule
 * the signature-verifying Twilio routes use (lib/sms/webhook-base.ts):
 * TWILIO_WEBHOOK_BASE_URL when set, else the app origin. Null when no usable
 * base exists; nothing is then configured or adopted.
 */
function urls(appOrigin: string, env: Env = process.env): { inbound: string; status: string } | null {
  const inbound = twilioWebhookUrl("/api/twilio/inbound-sms", appOrigin, env);
  const status = twilioWebhookUrl(SMS_STATUS_CALLBACK_PATH, appOrigin, env);
  return inbound && status ? { inbound, status } : null;
}

/** Refused before any claim: no usable webhook base to configure or require. */
export type WebhookBaseRefusal = { ok: false; result: "refused"; reason: "webhook_base_unusable" };
const WEBHOOK_BASE_UNUSABLE: WebhookBaseRefusal = { ok: false, result: "refused", reason: "webhook_base_unusable" };

/**
 * Is this number (or Messaging Service) already recorded on ANOTHER studio's
 * sender row? (This studio's own claim on it is its own retry.)
 * 0191's unique indexes would refuse the finalize AFTER a write-once claim;
 * asking first (0226 studio_sms_resource_recorded, a read) refuses before it.
 * Null = the database did not answer: the caller treats that as uncertain.
 */
async function resourceRecorded(
  admin: SupabaseClient,
  studioId: string,
  phoneNumber: string | null,
  messagingServiceSid: string | null,
): Promise<boolean | null> {
  try {
    const { data, error } = await admin.rpc("studio_sms_resource_recorded", {
      p_studio_id: studioId,
      p_phone_number: phoneNumber,
      p_messaging_service_sid: messagingServiceSid,
    });
    if (error || typeof data !== "boolean") return null;
    return data;
  } catch {
    return null;
  }
}

export async function runSenderProvision(
  deps: SenderControlsDeps,
  input: { studioId: string; actorUserId: string; country: string; areaCode: string | null; phoneNumber: string },
): Promise<ProvisionOutcome | CountryRefusal | WebhookBaseRefusal | PreClaimRefusal> {
  if (!isSenderCountry(input.country)) return { ok: false, result: "refused", reason: "invalid_input" };
  // Before any claim: the number, and any area code, are the chosen country's.
  if (
    !numberMatchesCountry(input.phoneNumber, input.country) ||
    (input.areaCode && !areaCodeMatchesCountry(input.areaCode, input.country))
  ) {
    return { ok: false, result: "refused", reason: "number_country_mismatch" };
  }
  // PROVENANCE (Codex P2 4253781002): a requested area code is recorded on the
  // claim, so the chosen number must actually be in it.
  if (input.areaCode && input.phoneNumber.slice(2, 5) !== input.areaCode) {
    return { ok: false, result: "refused", reason: "area_code_mismatch" };
  }
  const u = urls(deps.appOrigin, deps.env);
  if (!u) return WEBHOOK_BASE_UNUSABLE;
  // A number another studio already holds is refused BEFORE the write-once
  // claim, so an ordinary stale search result cannot wedge setup
  // (Codex P2 4251989009); 0226's release covers what slips past this.
  const recorded = await resourceRecorded(deps.admin, input.studioId, input.phoneNumber, null);
  if (recorded === null) return { ok: false, result: "refused", reason: "recorded_check_unavailable", uncertain: true };
  if (recorded) return { ok: false, result: "refused", reason: "resource_already_recorded", uncertain: false };
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
): Promise<AdoptionOutcome | CountryRefusal | PreClaimRefusal | WebhookBaseRefusal> {
  if (!isSenderCountry(input.country)) return { ok: false, result: "refused", reason: "invalid_input" };
  if (!numberMatchesCountry(input.phoneNumber, input.country)) {
    return { ok: false, result: "refused", reason: "number_country_mismatch" };
  }
  const u = urls(deps.appOrigin, deps.env);
  if (!u) return WEBHOOK_BASE_UNUSABLE;

  // PROVE IT CAN BE ADOPTED BEFORE THE CLAIM (Codex P2 4250840773). The
  // orchestration claims first and checks ownership second; 0191 makes the
  // claimed number write-once, so a typo it then parks in `error` would wedge
  // the studio's setup for good. The same READ-ONLY provider calls the
  // orchestration makes (lookupOwnedNumber, readMessagingServiceConfig; neither
  // mutates anything) run here first, with the orchestration's own refusal
  // vocabulary. The orchestration still re-checks after claiming, because
  // ownership can change in between.
  const refuse = (reason: PreClaimRefusal["reason"], uncertain: boolean): PreClaimRefusal => ({
    ok: false,
    result: "refused",
    reason,
    uncertain,
  });
  // Already recorded on any sender row (this or another studio): the finalize
  // would hit 0191's uniqueness after a write-once claim (Codex P2 4251747847).
  const recorded = await resourceRecorded(deps.admin, input.studioId, input.phoneNumber, input.messagingServiceSid);
  if (recorded === null) return refuse("recorded_check_unavailable", true);
  if (recorded) return refuse("resource_already_recorded", false);
  const owned = await deps.provider.lookupOwnedNumber({
    phoneNumber: input.phoneNumber,
    expectedMessagingServiceSid: input.messagingServiceSid,
  });
  if (!owned.ok) return refuse("ownership_unverified", true);
  const { phoneNumberSid, phoneNumber: reported, association, numberSmsUrl, numberSmsMethod, numberSmsApplicationSid } =
    owned.facts;
  if (!phoneNumberSid) return refuse("number_not_owned_by_account", false);
  if (reported !== input.phoneNumber) return refuse("provider_number_mismatch", false);
  switch (association.kind) {
    case "in_expected_service":
      break;
    case "in_other_service":
      return refuse("number_in_other_service", false);
    case "not_associated":
      return refuse("number_not_in_named_service", false);
    case "ambiguous":
      return refuse("number_association_ambiguous", false);
    case "unavailable":
      return refuse("number_association_unavailable", true);
  }
  const config = await deps.provider.readMessagingServiceConfig({ messagingServiceSid: input.messagingServiceSid });
  if (!config.ok) return refuse("ownership_unverified", true);
  // Inbound (STOP included) must EFFECTIVELY reach Hone: the number's own
  // webhook when the service routes inbound to it, else the service's.
  // An unreported routing flag is UNKNOWN: refused as uncertain, never passed.
  const inbound = inboundReaches(
    {
      serviceInboundUrl: config.config.inboundRequestUrl,
      serviceInboundMethod: config.config.inboundMethod,
      useInboundWebhookOnNumber: config.config.useInboundWebhookOnNumber,
      numberSmsUrl,
      numberSmsMethod,
      numberSmsApplicationSid,
    },
    u.inbound,
  );
  if (inbound === "unknown") return refuse("inbound_routing_unknown", true);
  if (inbound === "no" || !sameTwilioWebhook(config.config.statusCallbackUrl, u.status)) {
    return refuse("service_webhooks_mismatch", false);
  }

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

// ---------------------------------------------------------------------------
// RELEASE AND CHOOSE AGAIN (Codex P2 4251989009)
// ---------------------------------------------------------------------------
// For a claim that failed DEFINITIVELY BEFORE ANY PURCHASE (0226 decides which:
// error, no recorded resource, last error number_no_longer_available or
// provider_resource_mismatch), the owner may release it and choose another
// number. The database alone cannot prove nothing was bought -- a purchase
// whose answer was lost is recorded nowhere until reconciled -- so between the
// two database calls the PROVIDER is asked (a read, lookupResourcesByClaim)
// what exists under the claim key. Anything found, or no complete answer,
// refuses: only a retry, which reconciles first, may continue that claim.

// ---------------------------------------------------------------------------
// WHICH RECOVERY AN ERRORED SETUP OFFERS (Codex P2 4271461595, 4271749292,
// 4272070468)
// ---------------------------------------------------------------------------
// The full routing table, every stored code against every origin and stage,
// is /srv/hone/handoffs/SMS_863_RECOVERY_ROUTING_TABLE_2026-10-14.md. Its
// finding: a setup's ORIGIN (provisioned by Hone, or adopted from the studio's
// own account) is not stored, and every retry-routed code can come from either
// origin, before or after identifiers are recorded. A provisioning retry of an
// adopted setup cannot find its untagged resources, and an adoption retry of a
// provisioned one is not proven. So no retry is honest without the origin, and
// this slice offers exactly:
//   * release -- 0226's definitive pre-purchase codes: give the claim up and
//     choose again (the release still asks the provider first);
//   * support -- any other code while in error: a truthful line that the
//     setup cannot be continued from this screen;
//   * none    -- not in error.
// An origin-aware retry (persist the origin, then retry through provisioning
// or adoption accordingly) is a follow-up feature, not this slice.

/** Exactly 0226's release_unpurchased_studio_sms_claim codes (pinned to the SQL by test). */
export const RELEASABLE_ERROR_CODES = ["number_no_longer_available", "provider_resource_mismatch", "finalize_conflict"] as const;

export type SenderRecovery = "release" | "support" | "none";

export function senderRecoveryFor(status: string | null | undefined, lastErrorCode: string | null | undefined): SenderRecovery {
  if (status !== "error") return "none";
  if (lastErrorCode && (RELEASABLE_ERROR_CODES as readonly string[]).includes(lastErrorCode)) return "release";
  return "support";
}

export type ReleaseOutcome =
  | { ok: true; result: "released"; senderId: string }
  | {
      ok: false;
      result: "refused";
      reason:
        | "invalid_input"
        | "not_a_member"
        | "not_owner"
        | "no_live_sender"
        | "not_releasable"
        | "sender_changed"
        | "resources_found"
        | "ownership_unverified"
        | "store_unavailable";
      uncertain: boolean;
    };

export async function runSenderRelease(
  deps: Pick<SenderControlsDeps, "admin" | "provider">,
  input: { studioId: string; actorUserId: string },
): Promise<ReleaseOutcome> {
  const refuse = (reason: Extract<ReleaseOutcome, { ok: false }>["reason"], uncertain = false): ReleaseOutcome => ({
    ok: false,
    result: "refused",
    reason,
    uncertain,
  });

  // 1. Is the studio's live claim releasable, and what is its key?
  let row: { result?: string; sender_id?: string | null; claim_key?: string | null; lease_generation?: number | null } | null = null;
  try {
    const { data, error } = await deps.admin.rpc("get_releasable_studio_sms_claim", {
      p_studio_id: input.studioId,
      p_actor_user_id: input.actorUserId,
    });
    if (error) return refuse("store_unavailable", true);
    row = (Array.isArray(data) ? data[0] : null) ?? null;
  } catch {
    return refuse("store_unavailable", true);
  }
  if (!row?.result) return refuse("store_unavailable", true);
  if (row.result !== "releasable" || !row.sender_id || !row.claim_key || typeof row.lease_generation !== "number") {
    const known = ["invalid_input", "not_a_member", "not_owner", "no_live_sender", "not_releasable"] as const;
    return refuse((known as readonly string[]).includes(row.result) ? (row.result as (typeof known)[number]) : "not_releasable");
  }

  // 2. The provider: does ANYTHING exist under this claim? A read.
  const found = await deps.provider.lookupResourcesByClaim(row.claim_key);
  if (!found.ok) return refuse("ownership_unverified", true);
  const f = found.found;
  if (f.phoneNumberSid || f.phoneNumber || f.messagingServiceSid) return refuse("resources_found");

  // 3. Release: compare-and-set on the sender, key AND lease generation the
  // provider was asked about, re-checked under lock. A retry in between takes
  // the generation forward, so its purchases cannot be released by this
  // answer (Codex P2 4266274277).
  try {
    const { data, error } = await deps.admin.rpc("release_unpurchased_studio_sms_claim", {
      p_studio_id: input.studioId,
      p_actor_user_id: input.actorUserId,
      p_expected_sender_id: row.sender_id,
      p_claim_key: row.claim_key,
      p_lease_generation: row.lease_generation,
    });
    if (error) return refuse("store_unavailable", true);
    if (data === "released") return { ok: true, result: "released", senderId: row.sender_id };
    const known = ["invalid_input", "not_a_member", "not_owner", "no_live_sender", "not_releasable", "sender_changed"] as const;
    return refuse((known as readonly string[]).includes(String(data)) ? (data as (typeof known)[number]) : "not_releasable");
  } catch {
    // The command may have run: never claim it did not.
    return refuse("store_unavailable", true);
  }
}

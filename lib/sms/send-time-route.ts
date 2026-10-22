import { classifyNanpNumber } from "./nanp";
import { destinationReadiness, type DestinationCountry, type ReadinessState } from "./sender-readiness";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readLiveRegistrationState } from "./sender-registration-admin";
import {
  bindingSenderFrom,
  registrationEvidenceFor,
  registrationKindFor,
  type LiveRegistrationSnapshot,
  type SenderRegistrationRow,
} from "./sender-registration";
import { campaignBindingVerdict, type RecordedCampaignBinding } from "./campaign-binding";
import { stopPreflightVerdict, type RecordedStopPreflight } from "./stop-preflight-record";
import type { SenderStatus, StudioSmsSenderState } from "./sender-status";

// ===========================================================================
// WILLOW-ROUTING-CANDIDATE-01 (#824): which identity may THIS message leave
// from, decided at send time, before any claim or provider call.
// ===========================================================================
//
// CANDIDATE ONLY. Nothing here activates per-studio sending:
//   * Every studio routes through the PLATFORM sender (today's behaviour,
//     exactly) unless its id is listed in SMS_STUDIO_ROUTING_STUDIO_IDS. That
//     variable is unset everywhere; listing a studio is the explicit cutover
//     gate and needs its own approval.
//   * The reader is the SMS lane's ONE-statement snapshot (0217,
//     get_live_studio_sms_sender_registration_state, via
//     readLiveRegistrationState): the sender rows, their messaging service and
//     their registrations together, so the sender checked is the sender used.
//     0217 is unapplied, so on production that read fails and a listed studio
//     REFUSES rather than sends. Tests inject a reader or answer the RPC.
//
// ORDER, in every appointment SMS path (lib/sms/send-appointment.ts):
//   1. consent gate: studio toggle, the client's opt-out, consent, phone;
//   2. the deployment fence;
//   3. THIS decision;
//   4. only then the claim (an attempt is spent) and the provider call.
// A refusal here therefore spends no attempt and reaches no provider: the
// next pass reconsiders the row intact once the configuration is fixed.
//
// What a studio-routed send requires, all of it re-read per send:
//   * exactly one ACTIVE sender, and it belongs to THIS studio (a reader that
//     hands back another studio's row is broken, and nothing is sent);
//   * a non-blank messaging service on it;
//   * a recipient that is a Canadian or US mobile-range number;
//   * the SMS lane's readiness model (lib/sms/sender-readiness.ts) saying
//     ACTIVE for that destination, fed only with registration evidence
//     recorded for THIS sender of THIS studio, for the number it holds NOW
//     (registrationEvidenceFor matches the number). Evidence for a released or
//     replaced sender, or for a number the sender used to hold, is stale and
//     is ignored, never inherited;
//   * HON-50 G7: for a US recipient from a 10DLC long code, the RECORDED
//     campaign binding (0229) of this sender proving its messaging service is
//     the one linked to the verified US A2P campaign (campaignBindingVerdict).
//     Recorded at evidence and cutover time, never fetched here: the send path
//     makes no provider call. A toll-free sender is held to toll-free
//     verification instead (readiness above), and a CA recipient needs no
//     10DLC campaign, so neither consults it;
//   * HON-50 G6, for EVERY destination (STOP is phone-wide): the RECORDED
//     inbound STOP preflight (0230) of this sender, passing, current, matching
//     this sender, number and service, and evaluated against the webhook base
//     the routes verify signatures against now (stopPreflightVerdict). A
//     studio whose STOP path was never proven sends nothing from its number.
//     Per the pending product decision this REFUSES; it never falls back.
//
// NOT DECIDED HERE: whether the provider relationship covers health
// information (BAA, #828; the SMS lane's NOT_HIPAA_COVERAGE). "Active" readiness never implies it; it is a
// separate gate on the cutover, and nothing here may be read as satisfying it.
// ===========================================================================

export const STUDIO_ROUTING_ENV = "SMS_STUDIO_ROUTING_STUDIO_IDS";

export type RoutingMode = "platform" | "studio";

/** The studios listed for routing; empty when the gate is unset. */
export function listedRoutingStudioIds(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const raw = env[STUDIO_ROUTING_ENV];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The cutover gate. Unset or empty: every studio stays on the platform sender. */
export function studioRoutingMode(studioId: string, env: Readonly<Record<string, string | undefined>> = process.env): RoutingMode {
  if (typeof studioId !== "string" || studioId.trim() === "") return "platform";
  return listedRoutingStudioIds(env).includes(studioId) ? "studio" : "platform";
}

/** One sender row as the (future) send-time command returns it. */
export type SendTimeSender = {
  id: string;
  studio_id: string;
  status: SenderStatus;
  phone_number: string | null;
  messaging_service_sid: string | null;
  /** 0229. Absent before 0229; read as unknown, so a binding reads stale. */
  provisioned_at?: string | null;
};

export type SendTimeRegistration = Pick<
  LiveRegistrationSnapshot,
  "studio_id" | "sender_id" | "phone_number" | "kind" | "status" | "missing_information"
>;

/** A read that did not answer is never "no sender". */
export type SendTimeRouteRead =
  | {
      ok: true;
      senders: SendTimeSender[];
      registrations: SendTimeRegistration[];
      /**
       * 0229, from the SAME snapshot. Absent is [] (no binding recorded, so a
       * US 10DLC send refuses as missing); present but not an array is an
       * answer this file does not understand, and refuses as unreadable.
       */
      campaignBindings?: RecordedCampaignBinding[];
      /** 0230, from the SAME snapshot, with the same absent/malformed rule. */
      stopPreflights?: RecordedStopPreflight[];
    }
  | { ok: false };

export type SendTimeRouteReader = (studioId: string) => Promise<SendTimeRouteRead>;

/** Unreadable by construction: the fallback when no admin client is at hand. */
export const unavailableSendTimeRouteReader: SendTimeRouteReader = async () => ({ ok: false });

/**
 * The send-time reader over 0217's snapshot. The SMS lane's parser already
 * refuses a row of another studio and a registration whose sender is not in
 * the snapshot; any such answer arrives here as unreadable.
 */
export function liveSendTimeRouteReader(admin: SupabaseClient): SendTimeRouteReader {
  return async (studioId) => {
    const state = await readLiveRegistrationState(admin, studioId);
    if (!state.ok) return { ok: false };
    return {
      ok: true,
      // An unknown status string is never "active", so it can never be chosen.
      senders: state.senders.map((s) => ({ ...s, status: s.status as SenderStatus })),
      registrations: state.registrations,
      campaignBindings: state.campaignBindings,
      stopPreflights: state.stopPreflights,
    };
  };
}

export type SendTimeRefusal =
  | "sender_read_failed"
  | "no_active_sender"
  | "ambiguous_active_sender"
  | "sender_wrong_studio"
  | "sender_identity_missing"
  | "recipient_unroutable"
  | "destination_not_ready"
  | "campaign_binding_missing"
  | "campaign_binding_mismatch"
  | "campaign_binding_unverified"
  | "campaign_binding_stale"
  | "stop_preflight_missing"
  | "stop_preflight_mismatch"
  | "stop_preflight_not_ready"
  | "stop_preflight_stale"
  | "stop_preflight_base_changed";

export type SendTimeRoute =
  | { ok: true; mode: "platform" }
  | {
      ok: true;
      mode: "studio";
      messagingServiceSid: string;
      /**
       * The exact number whose readiness was checked, sent as `From` beside the
       * service: a service is a POOL, and without it the provider may choose
       * another number in it (lib/sms/provider/types.ts, fromPhoneNumber).
       */
      fromNumber: string;
      senderId: string;
      destination: DestinationCountry;
    }
  | { ok: false; reason: SendTimeRefusal; readiness?: ReadinessState };

function asReadinessSender(s: SendTimeSender): StudioSmsSenderState {
  return {
    id: s.id,
    studio_id: s.studio_id,
    provider: "twilio",
    status: s.status,
    country: null,
    requested_area_code: null,
    phone_number: s.phone_number,
    provisioned_at: null,
    last_test_ok_at: null,
    last_error_code: null,
    last_error_at: null,
    released_at: null,
    created_at: "",
    updated_at: "",
  };
}

/** The studio-mode decision. Pure: reads nothing, sends nothing. */
export function decideStudioRoute(input: {
  studioId: string;
  recipientE164: string;
  read: SendTimeRouteRead;
  /** The env the STOP preflight's webhook base is compared against. */
  env?: Readonly<Record<string, string | undefined>>;
}): SendTimeRoute {
  const { studioId, recipientE164, read } = input;
  const env = input.env ?? process.env;
  if (
    !read.ok ||
    !Array.isArray(read.senders) ||
    !Array.isArray(read.registrations) ||
    (read.campaignBindings !== undefined && !Array.isArray(read.campaignBindings)) ||
    (read.stopPreflights !== undefined && !Array.isArray(read.stopPreflights))
  ) {
    return { ok: false, reason: "sender_read_failed" };
  }
  // A row that is not an object is an answer this file does not understand:
  // a refusal, never an exception thrown into the send path.
  if (
    read.senders.some((s) => !s || typeof s !== "object") ||
    read.registrations.some((r) => !r || typeof r !== "object")
  ) {
    return { ok: false, reason: "sender_read_failed" };
  }
  // Any row of another studio means the read is not the studio's own: refuse
  // outright rather than filter, so a broken reader can never pick a sender.
  if (read.senders.some((s) => s.studio_id !== studioId)) {
    return { ok: false, reason: "sender_wrong_studio" };
  }
  const active = read.senders.filter((s) => s.status === "active");
  if (active.length === 0) return { ok: false, reason: "no_active_sender" };
  if (active.length > 1) return { ok: false, reason: "ambiguous_active_sender" };
  const sender = active[0];

  const sid = sender.messaging_service_sid;
  if (typeof sid !== "string" || sid.trim() === "") {
    return { ok: false, reason: "sender_identity_missing" };
  }

  const senderNumber = classifyNanpNumber(sender.phone_number);
  const recipient = classifyNanpNumber(recipientE164);
  if (!recipient.ok || (recipient.country !== "CA" && recipient.country !== "US")) {
    return { ok: false, reason: "recipient_unroutable" };
  }
  const destination: DestinationCountry = recipient.country;

  // Only THIS sender's evidence, recorded for THIS studio. Anything else is
  // stale (a previous number) or foreign, and is ignored, never inherited.
  const current = read.registrations.filter((r) => r.sender_id === sender.id && r.studio_id === studioId);
  const evidence = registrationEvidenceFor(
    { ok: true, rows: current as unknown as SenderRegistrationRow[] },
    sender.phone_number,
  );
  const readiness = destinationReadiness(destination, { ok: true, sender: asReadinessSender(sender) }, evidence);
  if (readiness.state !== "active") {
    return { ok: false, reason: "destination_not_ready", readiness: readiness.state };
  }
  // Readiness "active" already required a classifiable number; checked again
  // here so the From the provider receives is the canonical E.164.
  if (!senderNumber.ok) return { ok: false, reason: "destination_not_ready", readiness: "failed" };
  // HON-50 G6. Every studio-routed message needs this sender's recorded, passing
  // STOP preflight, whatever the destination.
  const preflight = (read.stopPreflights ?? []).find((p) => p?.senderId === sender.id) ?? null;
  const stop = stopPreflightVerdict(
    preflight,
    bindingSenderFrom({ ...sender, provisioned_at: sender.provisioned_at ?? null }),
    env,
  );
  if (!stop.ok) return { ok: false, reason: `stop_preflight_${stop.reason}` };
  // HON-50 G7. US traffic from a 10DLC long code also needs the recorded
  // campaign binding of THIS sender, checked against this snapshot's sender.
  if (destination === "US" && registrationKindFor(sender.phone_number) === "us_10dlc") {
    const binding = (read.campaignBindings ?? []).find((b) => b?.senderId === sender.id) ?? null;
    const verdict = campaignBindingVerdict(
      binding,
      bindingSenderFrom({ ...sender, provisioned_at: sender.provisioned_at ?? null }),
    );
    if (!verdict.ok) return { ok: false, reason: `campaign_binding_${verdict.reason}` };
  }
  return {
    ok: true,
    mode: "studio",
    messagingServiceSid: sid,
    fromNumber: senderNumber.e164,
    senderId: sender.id,
    destination,
  };
}

/**
 * The send-time route for one message. Platform mode (every studio today)
 * reads nothing and changes nothing. Studio mode reads through `reader` and
 * fails closed on anything it cannot read.
 */
export async function resolveSendTimeRoute(input: {
  studioId: string;
  recipientE164: string;
  reader?: SendTimeRouteReader;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<SendTimeRoute> {
  if (studioRoutingMode(input.studioId, input.env) === "platform") {
    return { ok: true, mode: "platform" };
  }
  try {
    const read = await (input.reader ?? unavailableSendTimeRouteReader)(input.studioId);
    return decideStudioRoute({ studioId: input.studioId, recipientE164: input.recipientE164, read, env: input.env });
  } catch {
    return { ok: false, reason: "sender_read_failed" };
  }
}

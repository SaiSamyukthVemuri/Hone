import { classifyNanpNumber } from "./nanp";
import { destinationReadiness, type DestinationCountry, type ReadinessState } from "./sender-readiness";
import { registrationEvidenceFor, type SenderRegistrationRow } from "./sender-registration";
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
//   * The production reader below always answers "unreadable", because the
//     command it needs does not exist yet (service_role holds no privilege on
//     studio_sms_senders, and 0194 returns only the messaging service). A
//     listed studio therefore REFUSES rather than sends until that command
//     lands. Tests inject a reader.
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
//     recorded for THIS sender of THIS studio. Evidence for a released or
//     replaced sender is stale and is ignored, never inherited.
//
// NOT DECIDED HERE: whether the provider relationship covers health
// information (BAA, #828). "Active" readiness never implies it; it is a
// separate gate on the cutover, and nothing here may be read as satisfying it.
// ===========================================================================

export const STUDIO_ROUTING_ENV = "SMS_STUDIO_ROUTING_STUDIO_IDS";

export type RoutingMode = "platform" | "studio";

/** The cutover gate. Unset or empty: every studio stays on the platform sender. */
export function studioRoutingMode(studioId: string, env: NodeJS.ProcessEnv = process.env): RoutingMode {
  const raw = env[STUDIO_ROUTING_ENV];
  if (!raw || typeof studioId !== "string" || studioId.trim() === "") return "platform";
  const listed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return listed.includes(studioId) ? "studio" : "platform";
}

/** One sender row as the (future) send-time command returns it. */
export type SendTimeSender = {
  id: string;
  studio_id: string;
  status: SenderStatus;
  phone_number: string | null;
  messaging_service_sid: string | null;
};

export type SendTimeRegistration = Pick<
  SenderRegistrationRow,
  "id" | "studio_id" | "sender_id" | "kind" | "status" | "missing_information" | "recorded_at" | "updated_at"
>;

/** A read that did not answer is never "no sender". */
export type SendTimeRouteRead =
  | { ok: true; senders: SendTimeSender[]; registrations: SendTimeRegistration[] }
  | { ok: false };

export type SendTimeRouteReader = (studioId: string) => Promise<SendTimeRouteRead>;

/**
 * The production reader until the send-time command exists: always
 * unreadable, so a studio listed for routing refuses instead of sending.
 */
export const unavailableSendTimeRouteReader: SendTimeRouteReader = async () => ({ ok: false });

export type SendTimeRefusal =
  | "sender_read_failed"
  | "no_active_sender"
  | "ambiguous_active_sender"
  | "sender_wrong_studio"
  | "sender_identity_missing"
  | "recipient_unroutable"
  | "destination_not_ready";

export type SendTimeRoute =
  | { ok: true; mode: "platform" }
  | {
      ok: true;
      mode: "studio";
      messagingServiceSid: string;
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
}): SendTimeRoute {
  const { studioId, recipientE164, read } = input;
  if (!read.ok || !Array.isArray(read.senders) || !Array.isArray(read.registrations)) {
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

  const recipient = classifyNanpNumber(recipientE164);
  if (!recipient.ok || (recipient.country !== "CA" && recipient.country !== "US")) {
    return { ok: false, reason: "recipient_unroutable" };
  }
  const destination: DestinationCountry = recipient.country;

  // Only THIS sender's evidence, recorded for THIS studio. Anything else is
  // stale (a previous number) or foreign, and is ignored, never inherited.
  const current = read.registrations.filter((r) => r.sender_id === sender.id && r.studio_id === studioId);
  const evidence = registrationEvidenceFor(
    { ok: true, rows: current as SenderRegistrationRow[] },
    sender.phone_number,
  );
  const readiness = destinationReadiness(destination, { ok: true, sender: asReadinessSender(sender) }, evidence);
  if (readiness.state !== "active") {
    return { ok: false, reason: "destination_not_ready", readiness: readiness.state };
  }
  return { ok: true, mode: "studio", messagingServiceSid: sid, senderId: sender.id, destination };
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
  env?: NodeJS.ProcessEnv;
}): Promise<SendTimeRoute> {
  if (studioRoutingMode(input.studioId, input.env) === "platform") {
    return { ok: true, mode: "platform" };
  }
  let read: SendTimeRouteRead;
  try {
    read = await (input.reader ?? unavailableSendTimeRouteReader)(input.studioId);
  } catch {
    read = { ok: false };
  }
  return decideStudioRoute({ studioId: input.studioId, recipientE164: input.recipientE164, read });
}

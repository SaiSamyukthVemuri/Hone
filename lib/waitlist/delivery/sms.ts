import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWaitlistInvitationSms } from "@/lib/sms/templates";
import { normalizePhoneForSms, sendSmsSafely, type SendSmsResult } from "@/lib/sms/twilio";
import {
  claimWaitlistInvitationSms,
  settleOutcomeForSend,
  settleSmsMessage,
  smsStatusCallbackUrl,
  type SmsSkipReason,
} from "@/lib/sms/delivery-ledger";
import { prospectMayReceiveSms } from "@/lib/waitlist/prospect-sms-consent";
import { invitationExpiryLabel } from "./policy";

// SMS-01 — a waitlist invitation's SMS, sent beside its email.
//
// ONE INVITATION ID = ONE DELIVERY EVENT, ON EVERY CHANNEL. The raw link token
// exists only in the memory of the request that minted the invitation (see
// send.ts), so this runs in that request or never. The database makes "at most
// one text per invitation" a fact: claim_waitlist_invitation_sms (0206) admits
// one claim per invitation id, and only while the invitation is live and the
// studio has switched waitlist SMS on.
//
// ELIGIBILITY IS NOT DECIDED HERE. prospectMayReceiveSms is the one authority:
// a STOP wins over everything, a number nobody verified is not a channel, and
// only then does consent decide. The claim returns the facts; this module
// applies the authority and records a skip with its reason when it says no.
//
// RETRIES. Twilio takes no idempotency key, so an attempt whose answer is lost
// (`ambiguous`) is never repeated: it may already have reached the prospect.
// Only a DEFINITE non-acceptance that is worth repeating (rate limited, or a
// connection that never opened) is tried once more, inside this request --
// there is no later request that could hold the token.
//
// DELIVERY IS NOT LIFECYCLE. Nothing here reads or writes invitation state, and
// no outcome here can turn an issued invitation into a failed one.
//
// LOGGING. One structured line per invitation: ids, the outcome word and a
// reason slug. Never the phone number, the link, the token or the body.

export type WaitlistInvitationSmsOutcome =
  | { state: "accepted" }
  | { state: "refused" | "unknown" }
  | { state: "skipped"; reason: SmsSkipReason }
  /** No claim was taken: switched off, not live, already texted, or the
   *  claim could not be reached (fail closed). */
  | { state: "not_claimed"; reason: string };

/** The gap before the one permitted repeat of a definite, retryable refusal. */
export const WAITLIST_SMS_RETRY_DELAY_MS = 750;

function eligibilitySkip(target: {
  smsOptedOutAt: string | null;
  mobileVerifiedAt: string | null;
  smsConsentAt: string | null;
}): SmsSkipReason | null {
  const record = {
    sms_opted_out_at: target.smsOptedOutAt,
    mobile_verified_at: target.mobileVerifiedAt,
    sms_consent_at: target.smsConsentAt,
  };
  if (prospectMayReceiveSms(record)) return null;
  // The authority said no; name why, in the authority's own order.
  if (record.sms_opted_out_at) return "opted_out";
  if (!record.mobile_verified_at) return "mobile_unverified";
  return "no_consent";
}

function log(fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ event: "waitlist_invitation_sms", ...fields, timestamp: new Date().toISOString() }),
  );
}

export async function sendWaitlistInvitationSms(args: {
  admin: SupabaseClient;
  studio: { id: string; name?: string | null };
  invitationId: string;
  /** The invitation's /invitation/<token> URL. Held in memory, never logged. */
  invitationUrl: string;
  /** Test seam for the retry gap. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<WaitlistInvitationSmsOutcome> {
  const ids = { studioId: args.studio.id, invitationId: args.invitationId };

  const claim = await claimWaitlistInvitationSms(args.admin, {
    studioId: args.studio.id,
    invitationId: args.invitationId,
  });
  if (claim.result !== "claimed") {
    log({ ...ids, outcome: "not_claimed", reason: claim.result });
    return { state: "not_claimed", reason: claim.result };
  }

  const skip =
    eligibilitySkip(claim.target) ??
    (normalizePhoneForSms(claim.target.phone) === null ? ("invalid_phone" as const) : null);
  if (skip) {
    await settleSmsMessage(args.admin, claim.messageId, { outcome: "skipped", skipReason: skip });
    log({ ...ids, outcome: "skipped", reason: skip });
    return { state: "skipped", reason: skip };
  }

  const to = normalizePhoneForSms(claim.target.phone) as string;
  const body = buildWaitlistInvitationSms({
    studioName: args.studio.name ?? "",
    invitationUrl: args.invitationUrl,
    // The DATABASE's deadline, as the claim returned it, rendered exactly as
    // the invitation email renders it.
    expiresAtLabel: invitationExpiryLabel(new Date(claim.target.expiresAt)),
  });
  const statusCallbackUrl = smsStatusCallbackUrl(claim.messageId);

  let result: SendSmsResult = await sendSmsSafely({ to, body, statusCallbackUrl });
  if (!result.ok && result.attempt === "refused" && result.retryable) {
    // Definitely not sent, and worth one more try: nothing can be duplicated.
    await (args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(
      WAITLIST_SMS_RETRY_DELAY_MS,
    );
    result = await sendSmsSafely({ to, body, statusCallbackUrl });
  }

  const settle = settleOutcomeForSend(result);
  await settleSmsMessage(args.admin, claim.messageId, settle);
  log({
    ...ids,
    outcome: settle.outcome,
    ...(settle.outcome === "skipped" ? { reason: settle.skipReason } : {}),
    ...(result.ok ? {} : { error: result.error }),
  });
  if (settle.outcome === "skipped") return { state: "skipped", reason: settle.skipReason };
  return { state: settle.outcome };
}

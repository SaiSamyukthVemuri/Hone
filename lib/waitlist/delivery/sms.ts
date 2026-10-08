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
import { recordOpsAlert } from "@/lib/ops/alerts";

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
// a STOP wins over everything, then recorded consent decides. Verification is
// optional (Roadmap v1.25, operator decision D4(2)). The claim returns the
// facts; this module applies the authority and records a skip with its reason
// when it says no. Three protections stay here:
// - the claim reads the consent and the phone from the same locked row, and
//   the database never lets a stored phone change, so the text goes to the
//   number the consent was recorded with;
// - a phone that does not normalise is never tried (`invalid_phone`);
// - a non-production deployment is fenced before any provider call
//   (`non_production_deployment`).
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
// reason slug. Never the phone number, the link, the token or the body. A
// text the provider refused, or whose answer was lost, also raises ONE
// `sms_send_failed` warning: this path has no later retry, a refusal will never
// produce a delivery callback, and an unresolved answer may never get one. The
// warning is DURABLE: it is raised before the ledger's best-effort settle, so a
// settle that stalls, or an invocation killed during it, cannot swallow it.

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
  log({
    ...ids,
    outcome: settle.outcome,
    ...(settle.outcome === "skipped" ? { reason: settle.skipReason } : {}),
    ...(result.ok ? {} : { error: result.error }),
  });
  // The durable failure alert first; the ledger settle below is best-effort.
  if (settle.outcome === "refused" || settle.outcome === "unknown") {
    await recordOpsAlert({
      severity: "warning",
      event: "sms_send_failed",
      message:
        settle.outcome === "refused"
          ? "A waitlist invitation text was refused by the provider; the invitation email is unaffected."
          : "A waitlist invitation text may not have been sent (the provider's answer was lost); the invitation email is unaffected.",
      studioId: args.studio.id,
      route: "lib/waitlist/delivery/sms",
      safeDetails: {
        purpose: "waitlist_invitation",
        sms_message_id: claim.messageId,
        outcome: settle.outcome,
        error: result.ok ? null : result.error,
        provider_error_code: result.ok ? null : (result.providerErrorCode ?? null),
      },
    });
  }
  await settleSmsMessage(args.admin, claim.messageId, settle);
  if (settle.outcome === "skipped") return { state: "skipped", reason: settle.skipReason };
  return { state: settle.outcome };
}

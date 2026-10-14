import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWaitlistJoinAckSms } from "@/lib/sms/templates";
import { normalizePhoneForSms, sendSmsSafely, type SendSmsResult } from "@/lib/sms/twilio";
import {
  claimWaitlistJoinAckSms,
  settleOutcomeForSend,
  settleSmsMessage,
  smsStatusCallbackUrl,
  type SmsSkipReason,
} from "@/lib/sms/delivery-ledger";
import { prospectMayReceiveSms } from "@/lib/waitlist/prospect-sms-consent";
import {
  lookupPhoneWideSuppression,
  type PhoneSuppressionAnswer,
} from "@/lib/sms/phone-suppression-lookup";
import { recordOpsAlert } from "@/lib/ops/alerts";

// SMS-04 — the ONE text a genuinely new waitlist join gets.
//
// WHO. Only a person who just joined on the public form and answered Yes, with
// a usable number and no STOP. The database decides "genuinely new" and "once":
// claim_waitlist_join_ack_sms (0210) admits one claim per entry, only for a
// still-waiting public-form entry whose consent is the form's own Yes recorded
// in the join itself, only within 15 minutes of the join, only once per number
// per 24 hours, and only while the studio's waitlist texts are on. Nobody
// already on a waitlist can qualify: consent recorded later (an owner's record,
// a backfill) is never the form's own, and turning the switch on runs nothing.
//
// WHEN. Called once, from the join request, after the database committed the
// entry and after the response was sent (waitlist-actions.ts). A duplicate
// submission never reaches here: the join answers already_waiting and creates
// no entry.
//
// THE SAME PROTECTIONS AS THE INVITATION TEXT (sms.ts), in the same order:
// - prospectMayReceiveSms is the one eligibility authority (STOP first, then
//   recorded consent; verification optional, D4(2));
// - a number that does not normalise is never tried (`invalid_phone`);
// - STOP is re-read PHONE-WIDE just before sending, and a failed read sends
//   nothing (`opted_out` / `suppression_check_failed`);
// - the production fence lives in sendSmsSafely (`non_production_deployment`).
// Every skip is settled on the claimed row with its reason.
//
// RETRIES. An attempt whose answer was lost (`ambiguous`) is never repeated:
// it may already have reached the person. Only a definite, retryable refusal
// is tried once more, inside this request.
//
// NOTHING ELSE. No entry state is read or written, the join's result and its
// emails are unaffected by any outcome here, and this never throws.
//
// LOGGING. One structured line per join: ids, the outcome and a reason slug.
// Never the phone number or the body. A refused or lost text also raises ONE
// durable `sms_send_failed` warning, before the best-effort ledger settle.

export type WaitlistJoinAckSmsOutcome =
  | { state: "accepted" }
  | { state: "refused" | "unknown" }
  | { state: "skipped"; reason: SmsSkipReason }
  /** No claim was taken: switched off, not a new self-service join with its
   *  own Yes, already texted, or the claim could not be reached (fail closed). */
  | { state: "not_claimed"; reason: string };

/** The gap before the one permitted repeat of a definite, retryable refusal. */
export const WAITLIST_JOIN_ACK_SMS_RETRY_DELAY_MS = 750;

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
  if (record.sms_opted_out_at) return "opted_out";
  return "no_consent";
}

function log(fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ event: "waitlist_join_ack_sms", ...fields, timestamp: new Date().toISOString() }),
  );
}

export async function sendWaitlistJoinAckSms(args: {
  admin: SupabaseClient;
  studio: { id: string; name?: string | null };
  /** The entry the join just created. */
  entryId: string;
  /** Test seam for the retry gap. */
  sleep?: (ms: number) => Promise<void>;
  /** The phone-wide STOP read. Defaults to the database lookup. */
  phoneSuppression?: (phone: string) => Promise<PhoneSuppressionAnswer>;
}): Promise<WaitlistJoinAckSmsOutcome> {
  const ids = { studioId: args.studio.id, entryId: args.entryId };

  const claim = await claimWaitlistJoinAckSms(args.admin, {
    studioId: args.studio.id,
    entryId: args.entryId,
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

  // STOP IS PHONE-WIDE, AND IT IS READ AT THE MOMENT OF SENDING: the number may
  // have said STOP on any client or prospect row, in any studio, before this
  // entry existed. A read that fails does not send.
  const phone = claim.target.phone as string;
  const suppression = await (args.phoneSuppression ??
    ((p: string) => lookupPhoneWideSuppression(args.admin, p)))(phone);
  const suppressionSkip: SmsSkipReason | null = !suppression.ok
    ? "suppression_check_failed"
    : suppression.suppressed
      ? "opted_out"
      : null;
  if (suppressionSkip) {
    await settleSmsMessage(args.admin, claim.messageId, {
      outcome: "skipped",
      skipReason: suppressionSkip,
    });
    log({ ...ids, outcome: "skipped", reason: suppressionSkip });
    return { state: "skipped", reason: suppressionSkip };
  }

  const to = normalizePhoneForSms(phone) as string;
  const body = buildWaitlistJoinAckSms({ studioName: args.studio.name ?? "" });
  const statusCallbackUrl = smsStatusCallbackUrl(claim.messageId);

  let result: SendSmsResult = await sendSmsSafely({ to, body, statusCallbackUrl });
  if (!result.ok && result.attempt === "refused" && result.retryable) {
    // Definitely not sent, and worth one more try: nothing can be duplicated.
    await (args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(
      WAITLIST_JOIN_ACK_SMS_RETRY_DELAY_MS,
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
          ? "A waitlist join acknowledgement text was refused by the provider; the person is on the waitlist and their acknowledgement email is unaffected."
          : "A waitlist join acknowledgement text may not have been sent (the provider's answer was lost); the person is on the waitlist and their acknowledgement email is unaffected.",
      studioId: args.studio.id,
      route: "lib/waitlist/delivery/join-ack-sms",
      safeDetails: {
        purpose: "waitlist_join_acknowledgement",
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

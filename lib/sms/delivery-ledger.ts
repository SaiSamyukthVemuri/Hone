import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SendSmsResult } from "./twilio";

// SMS-00 — the outbound SMS delivery ledger (migration 0206).
//
// One row per outbound SMS attempt, in public.sms_outbound_messages:
//
//   claim  ->  provider call  ->  settle  ->  delivery-status callbacks
//
// The row exists BEFORE the provider is called. Twilio's Messages API takes no
// idempotency key, so an attempt whose answer is lost may still have sent the
// message; a row that already exists is what a delivery-status callback can
// land on (it is addressed by row id in the signed StatusCallback URL), and a
// later callback is what turns an `unknown` settle into the truth.
//
// FAIL-SOFT, WITH ONE EXCEPTION. Recording an appointment attempt is
// bookkeeping: if the ledger cannot be written, the send it describes must
// still happen exactly as it did before this ledger existed. The waitlist
// invitation CLAIM is different -- it is the once-per-invitation guard -- so
// when it cannot be taken the invitation is not texted (fail closed).
//
// PRIVACY. Nothing here writes or logs a phone number, a message body or a
// provider message. The ledger holds purpose, subject, status, the provider
// SID and Twilio's numeric error code.

export type SmsPurpose =
  | "appointment_confirmation"
  | "appointment_reminder_24h"
  | "appointment_reminder_2h"
  | "waitlist_invitation";

export type AppointmentSmsPurpose = Exclude<SmsPurpose, "waitlist_invitation">;

/**
 * Why a claimed attempt made no provider call. A closed vocabulary: the
 * database checks only the slug's shape, so this list is where its meaning
 * lives.
 */
export const SMS_SKIP_REASONS = [
  "opted_out",
  "no_consent",
  "mobile_unverified",
  "invalid_phone",
  "non_production_deployment",
  "provider_not_configured",
  // 0208: the phone-wide STOP check could not be read, so the text is not sent.
  "suppression_check_failed",
] as const;
export type SmsSkipReason = (typeof SMS_SKIP_REASONS)[number];

export type SmsSettleOutcome =
  | { outcome: "accepted"; providerMessageSid: string }
  | { outcome: "refused" | "unknown"; providerErrorCode?: number | null }
  | { outcome: "skipped"; skipReason: SmsSkipReason };

/** Twilio's delivery lifecycle as the ledger stores it. */
export type ProviderDeliveryStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "undelivered"
  | "failed";

/**
 * Normalise a Twilio MessageStatus. `accepted` and `scheduled` mean the same
 * thing to Hone as `queued` (the provider holds it, nothing has left), `read`
 * implies `delivered`, and `canceled` means it will never be sent. Anything
 * else -- including inbound statuses that cannot describe an outbound message
 * -- is not a status this ledger records.
 */
export function normalizeTwilioMessageStatus(raw: unknown): ProviderDeliveryStatus | null {
  switch (raw) {
    case "accepted":
    case "scheduled":
    case "queued":
      return "queued";
    case "sending":
      return "sending";
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "undelivered":
      return "undelivered";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return null;
  }
}

/** The end states a studio-attributed alert is raised for. */
export function isFailedDeliveryStatus(status: ProviderDeliveryStatus): boolean {
  return status === "undelivered" || status === "failed";
}

export const SMS_STATUS_CALLBACK_PATH = "/api/twilio/message-status";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_SID_RE = /^(SM|MM)[0-9a-fA-F]{32}$/;

export function isLedgerMessageId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isProviderMessageSid(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_SID_RE.test(value);
}

/**
 * The StatusCallback URL for one attempt, or null when delivery reports cannot
 * be received.
 *
 * Built from TWILIO_WEBHOOK_BASE_URL -- the same base the inbound webhook signs
 * against -- because Twilio signs the exact URL it calls and the callback route
 * re-derives that URL from this variable. Without it there is no stable public
 * URL to hand Twilio, so the attempt is sent without a callback and is settled
 * from the provider's synchronous answer alone.
 */
export function smsStatusCallbackUrl(
  messageId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isLedgerMessageId(messageId)) return null;
  const base = env.TWILIO_WEBHOOK_BASE_URL;
  if (!base) return null;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${base.replace(/\/+$/, "")}${SMS_STATUS_CALLBACK_PATH}?m=${messageId}`;
}

/** What the transport's answer means for the ledger. */
export function settleOutcomeForSend(result: SendSmsResult): SmsSettleOutcome {
  if (result.ok) {
    return { outcome: "accepted", providerMessageSid: result.messageSid };
  }
  switch (result.attempt) {
    case "none":
      return {
        outcome: "skipped",
        skipReason:
          result.error === "sms_fenced_non_production"
            ? "non_production_deployment"
            : "provider_not_configured",
      };
    case "refused":
      return { outcome: "refused", providerErrorCode: result.providerErrorCode ?? null };
    case "ambiguous":
      return { outcome: "unknown", providerErrorCode: result.providerErrorCode ?? null };
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function logLedger(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

/**
 * Create the ledger row for one appointment SMS attempt. Call ONLY after
 * claim_sms_send has claimed the attempt; this does not decide whether a send
 * may happen. Returns the row id, or null when it could not be written -- in
 * which case the caller sends exactly as before, just without delivery
 * reports.
 */
export async function beginAppointmentSmsMessage(
  admin: SupabaseClient,
  input: { studioId: string; appointmentId: string; purpose: AppointmentSmsPurpose },
): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc("begin_appointment_sms_message", {
      p_studio_id: input.studioId,
      p_appointment_id: input.appointmentId,
      p_purpose: input.purpose,
    });
    if (error) {
      logLedger("sms_ledger_begin_failed", { purpose: input.purpose, shape: "rpc_error" });
      return null;
    }
    return isLedgerMessageId(data) ? data : null;
  } catch {
    logLedger("sms_ledger_begin_failed", { purpose: input.purpose, shape: "threw" });
    return null;
  }
}

export type WaitlistInvitationSmsTarget = {
  phone: string | null;
  smsConsentAt: string | null;
  smsOptedOutAt: string | null;
  mobileVerifiedAt: string | null;
  expiresAt: string;
};

export type WaitlistInvitationSmsClaim =
  | { result: "claimed"; messageId: string; target: WaitlistInvitationSmsTarget }
  | {
      result:
        | "already_claimed"
        | "not_found"
        | "not_live"
        | "studio_disabled"
        | "invalid_input";
    }
  /** The claim could not be taken or read. Fail closed: no text. */
  | { result: "unavailable" };

const CLAIM_REFUSALS = new Set([
  "already_claimed",
  "not_found",
  "not_live",
  "studio_disabled",
  "invalid_input",
]);

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function claimWaitlistInvitationSms(
  admin: SupabaseClient,
  input: { studioId: string; invitationId: string },
): Promise<WaitlistInvitationSmsClaim> {
  try {
    const { data, error } = await admin.rpc("claim_waitlist_invitation_sms", {
      p_studio_id: input.studioId,
      p_invitation_id: input.invitationId,
    });
    if (error) {
      logLedger("sms_invitation_claim_failed", { shape: "rpc_error" });
      return { result: "unavailable" };
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    const result = row?.result;
    if (result === "claimed") {
      const expiresAt = stringOrNull(row?.expires_at);
      if (!isLedgerMessageId(row?.message_id) || !expiresAt) {
        logLedger("sms_invitation_claim_failed", { shape: "malformed_claim" });
        return { result: "unavailable" };
      }
      return {
        result: "claimed",
        messageId: row.message_id as string,
        target: {
          phone: stringOrNull(row?.phone),
          smsConsentAt: stringOrNull(row?.sms_consent_at),
          smsOptedOutAt: stringOrNull(row?.sms_opted_out_at),
          mobileVerifiedAt: stringOrNull(row?.mobile_verified_at),
          expiresAt,
        },
      };
    }
    if (typeof result === "string" && CLAIM_REFUSALS.has(result)) {
      return { result } as WaitlistInvitationSmsClaim;
    }
    logLedger("sms_invitation_claim_failed", { shape: "unknown_result" });
    return { result: "unavailable" };
  } catch {
    logLedger("sms_invitation_claim_failed", { shape: "threw" });
    return { result: "unavailable" };
  }
}

export type SmsSettleResult =
  | "settled"
  | "already_settled"
  | "not_found"
  | "not_claimed"
  | "invalid_input";

const SETTLE_RESULTS = new Set<string>([
  "settled",
  "already_settled",
  "not_found",
  "not_claimed",
  "invalid_input",
]);

/**
 * Record what the provider answered. Returns the command's result, or null
 * when the ledger could not be reached; never throws, because the send it
 * describes has already happened (or definitely has not) either way.
 */
export async function settleSmsMessage(
  admin: SupabaseClient,
  messageId: string,
  settle: SmsSettleOutcome,
): Promise<SmsSettleResult | null> {
  try {
    const { data, error } = await admin.rpc("settle_sms_message", {
      p_message_id: messageId,
      p_outcome: settle.outcome,
      p_provider_message_sid:
        settle.outcome === "accepted" ? settle.providerMessageSid : null,
      p_provider_error_code:
        settle.outcome === "refused" || settle.outcome === "unknown"
          ? (settle.providerErrorCode ?? null)
          : null,
      p_skip_reason: settle.outcome === "skipped" ? settle.skipReason : null,
    });
    if (error) {
      logLedger("sms_ledger_settle_failed", { outcome: settle.outcome, shape: "rpc_error" });
      return null;
    }
    if (typeof data === "string" && SETTLE_RESULTS.has(data)) {
      if (data !== "settled" && data !== "already_settled") {
        logLedger("sms_ledger_settle_refused", { outcome: settle.outcome, result: data });
      }
      return data as SmsSettleResult;
    }
    logLedger("sms_ledger_settle_failed", { outcome: settle.outcome, shape: "unknown_result" });
    return null;
  } catch {
    logLedger("sms_ledger_settle_failed", { outcome: settle.outcome, shape: "threw" });
    return null;
  }
}

export type SmsDeliveryStatusResult = {
  result:
    | "updated"
    | "stale"
    | "unknown_message"
    | "sid_mismatch"
    | "not_sent"
    | "invalid_input";
  studioId: string | null;
  purpose: SmsPurpose | null;
  /** The appointment the attempt was about, for appointment purposes. */
  appointmentId: string | null;
};

const STATUS_RESULTS = new Set<string>([
  "updated",
  "stale",
  "unknown_message",
  "sid_mismatch",
  "not_sent",
  "invalid_input",
]);
const PURPOSES = new Set<string>([
  "appointment_confirmation",
  "appointment_reminder_24h",
  "appointment_reminder_2h",
  "waitlist_invitation",
]);

/**
 * Apply one signature-verified delivery-status callback. Returns null when the
 * ledger could not be reached, so the route can answer the provider honestly.
 */
export async function recordSmsDeliveryStatus(
  admin: SupabaseClient,
  input: {
    messageId: string;
    providerMessageSid: string;
    status: ProviderDeliveryStatus;
    providerErrorCode: number | null;
  },
): Promise<SmsDeliveryStatusResult | null> {
  try {
    const { data, error } = await admin.rpc("record_sms_delivery_status", {
      p_message_id: input.messageId,
      p_provider_message_sid: input.providerMessageSid,
      p_status: input.status,
      p_provider_error_code: input.providerErrorCode,
    });
    if (error) {
      logLedger("sms_ledger_status_failed", { shape: "rpc_error" });
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    const result = row?.result;
    if (typeof result !== "string" || !STATUS_RESULTS.has(result)) {
      logLedger("sms_ledger_status_failed", { shape: "unknown_result" });
      return null;
    }
    return {
      result: result as SmsDeliveryStatusResult["result"],
      studioId: isLedgerMessageId(row?.studio_id) ? (row?.studio_id as string) : null,
      purpose:
        typeof row?.purpose === "string" && PURPOSES.has(row.purpose)
          ? (row.purpose as SmsPurpose)
          : null,
      appointmentId: isLedgerMessageId(row?.appointment_id)
        ? (row?.appointment_id as string)
        : null,
    };
  } catch {
    logLedger("sms_ledger_status_failed", { shape: "threw" });
    return null;
  }
}

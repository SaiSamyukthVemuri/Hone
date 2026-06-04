import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client, Studio, SmsType } from "@/lib/types/database";
import {
  buildBookingConfirmationSms,
  build24hReminderSms,
  build2hReminderSms,
} from "./templates";
import {
  maskedPhone,
  normalizePhoneForSms,
  sendSmsSafely,
} from "./twilio";

// SMS send helpers used by the booking, reschedule, and reminder cron
// paths. Each top-level function follows the strict claim-then-send-
// then-record pattern documented in the migration 0049 header:
//
//   1. claimSmsSend (DB RPC) atomically reserves the right to send
//      one SMS of this type for this appointment. Increments the
//      send_attempts counter, stamps claimed_at. If another process
//      holds a fresh claim, or attempts are exhausted, or the SMS has
//      already been sent, returns false and we bail.
//   2. Only after a successful claim do we POST to Twilio.
//   3. In a `finally`, recordSmsResult (DB RPC) stamps sent_at on
//      success and clears claimed_at; on failure it just clears
//      claimed_at. Attempts are NOT incremented here; the claim
//      already did.
//
// A crashed process between claim and record leaves a stale claim;
// after 5 minutes the next claim_sms_send call can reclaim. That is
// the intended fallback for hard crashes; ordinary failures are
// covered by the finally block.
//
// Every send path also checks the studio toggle, the client's
// sms_consent_at / sms_opted_out_at, that we have a normalizable
// phone, and that the appointment has not already been sent (the
// last is also enforced by claim_sms_send; we short-circuit early to
// avoid an unnecessary DB roundtrip on common skip cases).

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type SmsSendResult =
  | { ok: true; messageSid: string }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped?: false; error: string; retryable: boolean };

// Re-export for callers that import alongside the send helpers.
export type { SmsType };

// ---------------------------------------------------------------------------
// Low-level claim/record wrappers
// ---------------------------------------------------------------------------

export async function claimSmsSend(
  admin: SupabaseClient,
  appointmentId: string,
  smsType: SmsType,
): Promise<boolean> {
  const { data, error } = await admin.rpc("claim_sms_send", {
    p_appointment_id: appointmentId,
    p_sms_type: smsType,
  });
  if (error) {
    console.error(
      JSON.stringify({
        event: "claim_sms_send_failed",
        appointmentId,
        smsType,
        error: String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
  return data === true;
}

export async function recordSmsResult(
  admin: SupabaseClient,
  appointmentId: string,
  smsType: SmsType,
  success: boolean,
): Promise<void> {
  const { error } = await admin.rpc("record_sms_result", {
    p_appointment_id: appointmentId,
    p_sms_type: smsType,
    p_success: success,
  });
  if (error) {
    // We intentionally do not throw. record_sms_result running after a
    // successful Twilio POST is the only way to stamp sent_at, so a
    // failure here means the row may still appear "not sent" in the DB
    // and the next cron pass could attempt a duplicate. The 5-minute
    // claim window provides a partial backstop; this log is the
    // operator's signal that something is wrong with Postgres.
    console.error(
      JSON.stringify({
        event: "record_sms_result_failed",
        appointmentId,
        smsType,
        success,
        error: String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

// PR #153. SMS give-up threshold. SMS retries are bounded by the
// claim_sms_send RPC's claim window (see migration 0049 + 0062);
// most non-retryable failures are Twilio rejections that should not
// be re-attempted (e.g. opt-out code 21610). We surface a
// warning-severity ops alert when retryable=false OR the attempt
// hit a cap. Lower-numbered retryable attempts stay log-only.
const SMS_GIVE_UP_ATTEMPT_THRESHOLD = 3;

export function logSmsFailure(opts: {
  appointmentId: string;
  smsType: SmsType;
  error: string;
  retryable: boolean;
  attemptNumber?: number;
  // PR #153. Optional studio id surfaces on the ops alert.
  studioId?: string | null;
}): void {
  console.error(
    JSON.stringify({
      event: "sms_send_failed",
      appointmentId: opts.appointmentId,
      smsType: opts.smsType,
      error: opts.error,
      retryable: opts.retryable,
      attemptNumber: opts.attemptNumber,
      timestamp: new Date().toISOString(),
    }),
  );
  const isFinalAttempt =
    !opts.retryable ||
    (typeof opts.attemptNumber === "number" &&
      opts.attemptNumber >= SMS_GIVE_UP_ATTEMPT_THRESHOLD);
  if (!isFinalAttempt) return;
  // Fire-and-forget; recordOpsAlert never throws to the caller.
  void (async () => {
    try {
      const { recordOpsAlert } = await import("@/lib/ops/alerts");
      await recordOpsAlert({
        severity: "warning",
        event: "sms_send_failed",
        message: `SMS ${opts.smsType} gave up after ${opts.attemptNumber ?? "?"} attempts.`,
        studioId: opts.studioId ?? null,
        appointmentId: opts.appointmentId,
        route: "lib/sms/send-appointment",
        safeDetails: {
          sms_type: opts.smsType,
          attempt_number: opts.attemptNumber ?? null,
          retryable: opts.retryable,
          provider_error: opts.error,
        },
      });
    } catch {
      // Swallow alerting exceptions so the SMS path is never broken.
    }
  })();
}

// ---------------------------------------------------------------------------
// Shared consent gate
// ---------------------------------------------------------------------------

type ConsentGateInput = {
  studio: Pick<
    Studio,
    | "send_confirmation_sms"
    | "send_24h_sms_reminders"
    | "send_2h_sms_reminders"
  >;
  client: Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at">;
  smsType: SmsType;
};

type ConsentGateResult =
  | { ok: true; normalizedPhone: string }
  | { ok: false; reason: string };

/**
 * Centralizes the gate every SMS send must clear before we even
 * attempt to claim. Returns the normalized phone on success so the
 * caller does not have to re-normalize.
 */
function passesConsentGate(input: ConsentGateInput): ConsentGateResult {
  const { studio, client, smsType } = input;

  const toggleOn =
    smsType === "confirmation"
      ? studio.send_confirmation_sms
      : smsType === "reminder_24h"
        ? studio.send_24h_sms_reminders
        : studio.send_2h_sms_reminders;
  if (!toggleOn) return { ok: false, reason: "studio_toggle_off" };

  if (client.sms_opted_out_at) {
    return { ok: false, reason: "client_opted_out" };
  }
  if (!client.sms_consent_at) {
    return { ok: false, reason: "client_no_consent" };
  }
  const normalized = normalizePhoneForSms(client.phone ?? null);
  if (!normalized) return { ok: false, reason: "invalid_phone" };

  return { ok: true, normalizedPhone: normalized };
}

// ---------------------------------------------------------------------------
// Public send helpers
// ---------------------------------------------------------------------------

type SendConfirmationInput = {
  admin: SupabaseClient;
  appointmentId: string;
  startsAt: Date;
  timezone: string;
  studio: Pick<
    Studio,
    | "name"
    | "send_confirmation_sms"
    | "send_24h_sms_reminders"
    | "send_2h_sms_reminders"
  >;
  client: Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at">;
  intakeUrl: string | null;
  // Single neutral manage-appointment link the SMS carries. Resolves
  // to /manage/<token>, which surfaces both reschedule and cancel as
  // follow-on actions after showing the studio's policies. Null when
  // the appointment has no cancellation_token (very old rows that
  // pre-date the PR 0025 token backfill); in that case the SMS omits
  // the manage line entirely.
  manageUrl: string | null;
};

export async function sendBookingConfirmationSmsToClient(
  input: SendConfirmationInput,
): Promise<SmsSendResult> {
  return sendOne({
    admin: input.admin,
    appointmentId: input.appointmentId,
    smsType: "confirmation",
    studio: input.studio,
    client: input.client,
    // Body builder does not depend on the phone; the callback API is
    // shared with the reminder helpers below to keep sendOne uniform.
    buildBody: () =>
      buildBookingConfirmationSms({
        studioName: input.studio.name,
        startsAt: input.startsAt,
        timezone: input.timezone,
        intakeUrl: input.intakeUrl,
        manageUrl: input.manageUrl,
      }),
    to: (normalizedPhone) => normalizedPhone,
  });
}

type SendReminderInput = {
  admin: SupabaseClient;
  appointmentId: string;
  startsAt: Date;
  timezone: string;
  studio: Pick<
    Studio,
    | "name"
    | "send_confirmation_sms"
    | "send_24h_sms_reminders"
    | "send_2h_sms_reminders"
  >;
  client: Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at">;
  // Reminder SMS carry the same neutral /manage/<token> link as
  // confirmation. The manage landing page surfaces both reschedule
  // and cancel options after the studio's policies.
  manageUrl: string | null;
};

export async function send24hReminderSmsToClient(
  input: SendReminderInput,
): Promise<SmsSendResult> {
  return sendOne({
    admin: input.admin,
    appointmentId: input.appointmentId,
    smsType: "reminder_24h",
    studio: input.studio,
    client: input.client,
    buildBody: () =>
      build24hReminderSms({
        studioName: input.studio.name,
        startsAt: input.startsAt,
        timezone: input.timezone,
        manageUrl: input.manageUrl,
      }),
    to: (normalizedPhone) => normalizedPhone,
  });
}

export async function send2hReminderSmsToClient(
  input: SendReminderInput,
): Promise<SmsSendResult> {
  return sendOne({
    admin: input.admin,
    appointmentId: input.appointmentId,
    smsType: "reminder_2h",
    studio: input.studio,
    client: input.client,
    buildBody: () =>
      build2hReminderSms({
        studioName: input.studio.name,
        startsAt: input.startsAt,
        timezone: input.timezone,
        manageUrl: input.manageUrl,
      }),
    to: (normalizedPhone) => normalizedPhone,
  });
}

// ---------------------------------------------------------------------------
// Shared one-shot send (private)
// ---------------------------------------------------------------------------

type SendOneArgs = {
  admin: SupabaseClient;
  appointmentId: string;
  smsType: SmsType;
  studio: ConsentGateInput["studio"];
  client: ConsentGateInput["client"];
  buildBody: (normalizedPhone: string) => string;
  to: (normalizedPhone: string) => string;
};

/**
 * The single send execution path all three public helpers funnel
 * through. Encapsulates:
 *   - consent gate
 *   - claim
 *   - Twilio POST (with timeout, in twilio.ts)
 *   - record_sms_result in finally
 *   - structured failure log
 *
 * Returns ok / skipped / error in a shape the caller can ignore
 * without breaking the booking, reschedule, or cron flow.
 */
async function sendOne(args: SendOneArgs): Promise<SmsSendResult> {
  const gate = passesConsentGate({
    studio: args.studio,
    client: args.client,
    smsType: args.smsType,
  });
  if (!gate.ok) {
    return { ok: false, skipped: true, reason: gate.reason };
  }

  const claimed = await claimSmsSend(args.admin, args.appointmentId, args.smsType);
  if (!claimed) {
    return { ok: false, skipped: true, reason: "not_claimed" };
  }

  let success = false;
  let outcome: SmsSendResult = {
    ok: false,
    error: "sms_send_unknown",
    retryable: true,
  };

  try {
    const body = args.buildBody(gate.normalizedPhone);
    const to = args.to(gate.normalizedPhone);
    const result = await sendSmsSafely({ to, body });
    success = result.ok;
    if (result.ok) {
      outcome = { ok: true, messageSid: result.messageSid };
    } else {
      outcome = {
        ok: false,
        error: result.error,
        retryable: result.retryable,
      };
      logSmsFailure({
        appointmentId: args.appointmentId,
        smsType: args.smsType,
        error: result.error,
        retryable: result.retryable,
      });
    }
  } catch (err) {
    success = false;
    const message = err instanceof Error ? err.message : String(err);
    outcome = {
      ok: false,
      error: "sms_send_exception",
      retryable: true,
    };
    logSmsFailure({
      appointmentId: args.appointmentId,
      smsType: args.smsType,
      error: `exception:${message}`,
      retryable: true,
    });
  } finally {
    await recordSmsResult(
      args.admin,
      args.appointmentId,
      args.smsType,
      success,
    );
  }

  // Light, log-only side effect so the operator sees masked phone +
  // outcome side by side in production logs. No PII.
  if (success && outcome.ok) {
    console.log(
      JSON.stringify({
        event: "sms_sent",
        appointmentId: args.appointmentId,
        smsType: args.smsType,
        messageSid: outcome.messageSid,
        toMasked: maskedPhone(gate.normalizedPhone),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return outcome;
}

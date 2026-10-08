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
  outboundSmsFence,
  sendSmsSafely,
  type SendSmsResult,
} from "./twilio";
import {
  beginAppointmentSmsMessage,
  settleOutcomeForSend,
  settleSmsMessage,
  smsStatusCallbackUrl,
  type AppointmentSmsPurpose,
} from "./delivery-ledger";

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
// SMS-00/SMS-02: every provider attempt also gets a row in the delivery
// ledger (lib/sms/delivery-ledger.ts), named in its StatusCallback so
// Twilio's delivery reports land on it. The ledger records; it never
// decides. claim_sms_send stays the authority on whether a send happens,
// and record_sms_result is written BEFORE the ledger row is settled: the
// settle is best-effort and must never stand between the provider's answer
// and the authoritative record.
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
    // PR #155: "id" is included on the studio Pick so the SMS failure
    // path can stamp studio_id on the ops_alerts row without a second
    // DB roundtrip. The consent-gate logic itself only consults the
    // three send_*_sms toggles; "id" is metadata for downstream
    // logSmsFailure / recordOpsAlert calls.
    | "id"
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
    // PR #155: "id" included so SMS alerts carry studio_id (see
    // ConsentGateInput comment above).
    | "id"
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

/** A cron reminder window, as reminderWindowIso returns it. */
export type ReminderWindow = { startIso: string; endIso: string };

export type SendReminderInput = {
  admin: SupabaseClient;
  appointmentId: string;
  /**
   * The cron window this reminder belongs to (reminderWindowIso). The start is
   * RE-READ after the claim and must still fall inside it.
   */
  window: ReminderWindow;
  timezone: string;
  // A FRESH secure intake link, or null. The cron passes non-null ONLY when
  // send_intake_reminders is on, this window's SMS toggle is on, and the LIVE
  // intake read said in_progress. The consent gate, the claim and the Twilio
  // contract below are untouched by it.
  intakeUrl?: string | null;
  studio: Pick<
    Studio,
    // PR #155: "id" included so SMS alerts carry studio_id (see
    // ConsentGateInput comment above).
    | "id"
    | "name"
    | "send_confirmation_sms"
    | "send_24h_sms_reminders"
    | "send_2h_sms_reminders"
  >;
  client: Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at">;
  /**
   * The neutral /manage/<token> link for a start, or null. A BUILDER rather
   * than a URL: the token expires at the appointment's start, so it is minted
   * from the start read after the claim -- never from the one the window
   * query saw, which a move may already have replaced.
   */
  manageUrlFor: (startsAt: Date) => string | null;
};

export async function send24hReminderSmsToClient(
  input: SendReminderInput,
): Promise<SmsSendResult> {
  return sendReminder("reminder_24h", input);
}

export async function send2hReminderSmsToClient(
  input: SendReminderInput,
): Promise<SmsSendResult> {
  return sendReminder("reminder_2h", input);
}

type ReminderClaim =
  | { result: "claimed"; startsAt: Date }
  | { result: "not_claimed" | "not_confirmed" | "outside_window" | "not_found" | "invalid_input" }
  /** The command could not be reached or answered unreadably. It is one
   *  transaction, so nothing was claimed and no attempt was spent. */
  | { result: "unavailable" };

const REMINDER_CLAIM_REFUSALS = new Set([
  "not_claimed",
  "not_confirmed",
  "outside_window",
  "not_found",
  "invalid_input",
]);

/**
 * claim_reminder_sms_send (0206): under the appointment row lock, refuse
 * unless the appointment is confirmed and starts inside this cron window, then
 * claim with claim_sms_send -- one transaction. The start it returns is the one
 * the reminder names.
 */
async function claimReminderSmsSend(
  admin: SupabaseClient,
  appointmentId: string,
  smsType: "reminder_24h" | "reminder_2h",
  window: ReminderWindow,
): Promise<ReminderClaim> {
  try {
    const { data, error } = await admin.rpc("claim_reminder_sms_send", {
      p_appointment_id: appointmentId,
      p_sms_type: smsType,
      p_window_start: window.startIso,
      p_window_end: window.endIso,
    });
    if (error) return { result: "unavailable" };
    const row = (Array.isArray(data) ? data[0] : data) as
      | { result?: unknown; starts_at?: unknown }
      | null;
    if (row?.result === "claimed") {
      const startsAt = new Date(String(row.starts_at));
      return Number.isNaN(startsAt.getTime())
        ? { result: "unavailable" }
        : { result: "claimed", startsAt };
    }
    if (typeof row?.result === "string" && REMINDER_CLAIM_REFUSALS.has(row.result)) {
      return { result: row.result } as ReminderClaim;
    }
    return { result: "unavailable" };
  } catch {
    return { result: "unavailable" };
  }
}

/**
 * SMS-02 — one appointment reminder SMS: gated, claimed, re-validated, sent,
 * settled. Beyond sendOne's gate and claim it closes the two gaps the
 * reminder path had:
 *
 *  1. CANCELLED OR MOVED AFTER THE WINDOW QUERY. claim_sms_send validates
 *     nothing, and the old re-check ran before it. The claim now goes through
 *     claim_reminder_sms_send, which checks status and window under the
 *     appointment row lock and claims in the same transaction: a cancelled
 *     appointment, or one moved out of this window, is refused without
 *     spending an attempt, and the message and its manage link are built from
 *     the start the claim returns -- so a move made before the send is
 *     reminded at its new start.
 *
 *  2. AN ANSWER THAT WAS LOST. Twilio takes no idempotency key, so an
 *     ambiguous attempt may already have reached the client, and retrying it
 *     could send the reminder twice. It is recorded as sent -- no automatic
 *     retry -- and the ledger keeps it `unknown` until a delivery callback
 *     says what happened; a failure then raises an ops alert. A definite
 *     refusal (including a connection that never opened) is retried on a
 *     later fire, within the 3-attempt budget, as before.
 *
 *  3. THE RECORD BEFORE THE LEDGER. record_sms_result is written as soon as
 *     the provider answers; only then is the ledger row settled. A settle
 *     that hangs, or an invocation killed during it, can no longer leave an
 *     accepted (or possibly accepted) reminder holding only its claim, which
 *     goes stale after five minutes and is reclaimed -- a duplicate. What is
 *     left is the one round trip between the answer and that record.
 *
 * A claim that could not be reached is a SKIP: no provider request was made
 * and no attempt spent, so the cron never counts it as an attempt.
 *
 * NOT HERE: a fresh reminder after a move whose reminder already went out.
 * The slot is recorded exactly as the provider answered; re-arming it safely
 * needs start-bound claims for email and SMS alike (follow-up SMS-03,
 * docs/13_BACKLOG_AND_DECISIONS.md).
 */
async function sendReminder(
  smsType: "reminder_24h" | "reminder_2h",
  args: SendReminderInput,
): Promise<SmsSendResult> {
  const gate = passesConsentGate({
    studio: args.studio,
    client: args.client,
    smsType,
  });
  if (!gate.ok) {
    return { ok: false, skipped: true, reason: gate.reason };
  }

  const fence = outboundSmsFence();
  if (!fence.allowed) {
    return { ok: false, skipped: true, reason: fence.reason };
  }

  // (1) Validate and claim in ONE transaction. A refusal spends no attempt;
  // an unreachable command spends none either (it rolled back), and is
  // retried on a later fire.
  const claim = await claimReminderSmsSend(args.admin, args.appointmentId, smsType, args.window);
  if (claim.result === "unavailable") {
    logSmsFailure({
      appointmentId: args.appointmentId,
      smsType,
      error: "reminder_claim_unavailable",
      retryable: true,
      studioId: args.studio.id,
    });
    // Logged, but a skip: nothing reached the provider.
    return { ok: false, skipped: true, reason: "reminder_claim_unavailable" };
  }
  if (claim.result !== "claimed") {
    return { ok: false, skipped: true, reason: claim.result };
  }
  const startsAt = claim.startsAt;

  let attempt: LedgeredAttempt;
  try {
    const build = smsType === "reminder_24h" ? build24hReminderSms : build2hReminderSms;
    const body = build({
      studioName: args.studio.name,
      startsAt,
      timezone: args.timezone,
      manageUrl: args.manageUrlFor(startsAt),
      intakeUrl: args.intakeUrl ?? null,
    });
    attempt = await sendWithLedgerRow({
      admin: args.admin,
      studioId: args.studio.id,
      appointmentId: args.appointmentId,
      smsType,
      to: gate.normalizedPhone,
      body,
    });
  } catch {
    // sendSmsSafely and the ledger never throw, so an exception here came from
    // building the message: nothing reached the provider.
    attempt = {
      result: { ok: false, error: "sms_render_failed", retryable: false, attempt: "none" },
      messageId: null,
    };
  }
  const result = attempt.result;

  // (2) The AUTHORITATIVE record, first. Sent, or possibly sent, counts as
  // sent: an ambiguous attempt is never retried automatically.
  const providerMayHaveIt = result.ok || result.attempt === "ambiguous";
  await recordSmsResult(args.admin, args.appointmentId, smsType, providerMayHaveIt);

  // (3) Then the best-effort ledger settle.
  await settleLedgerRow(args.admin, attempt);

  if (result.ok) {
    console.log(
      JSON.stringify({
        event: "sms_sent",
        appointmentId: args.appointmentId,
        smsType,
        messageSid: result.messageSid,
        toMasked: maskedPhone(gate.normalizedPhone),
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: true, messageSid: result.messageSid };
  }

  const ambiguous = result.attempt === "ambiguous";
  logSmsFailure({
    appointmentId: args.appointmentId,
    smsType,
    error: ambiguous ? `${result.error}:outcome_unknown` : result.error,
    // An ambiguous attempt is never retried automatically, so it is final.
    retryable: ambiguous ? false : result.retryable,
    studioId: args.studio.id,
  });
  return {
    ok: false,
    error: result.error,
    retryable: ambiguous ? false : result.retryable,
  };
}

// ---------------------------------------------------------------------------
// Ledger plumbing shared by every appointment SMS (SMS-00 / SMS-02)
// ---------------------------------------------------------------------------

const LEDGER_PURPOSE: Record<SmsType, AppointmentSmsPurpose> = {
  confirmation: "appointment_confirmation",
  reminder_24h: "appointment_reminder_24h",
  reminder_2h: "appointment_reminder_2h",
};

/** One provider attempt and the ledger row that names it (null without one). */
type LedgeredAttempt = { result: SendSmsResult; messageId: string | null };

/**
 * One provider attempt with its ledger row: created after the claim and named
 * in the StatusCallback, so delivery reports land on it. FAIL-SOFT: without a
 * row the message is sent exactly as before, only without delivery reports.
 * Never throws.
 *
 * It does NOT settle the row. The caller records the authoritative slot
 * (record_sms_result) first and only then calls settleLedgerRow.
 */
async function sendWithLedgerRow(args: {
  admin: SupabaseClient;
  studioId: string;
  appointmentId: string;
  smsType: SmsType;
  to: string;
  body: string;
}): Promise<LedgeredAttempt> {
  const messageId = await beginAppointmentSmsMessage(args.admin, {
    studioId: args.studioId,
    appointmentId: args.appointmentId,
    purpose: LEDGER_PURPOSE[args.smsType],
  });
  const result = await sendSmsSafely({
    to: args.to,
    body: args.body,
    statusCallbackUrl: messageId ? smsStatusCallbackUrl(messageId) : null,
  });
  return { result, messageId };
}

/**
 * Best-effort: settle the attempt's ledger row with the provider's answer.
 * Call only AFTER record_sms_result. Never throws; a row it never settles
 * stays `claimed`, which monitoring surfaces as unresolved.
 */
async function settleLedgerRow(admin: SupabaseClient, attempt: LedgeredAttempt): Promise<void> {
  if (attempt.messageId) {
    await settleSmsMessage(admin, attempt.messageId, settleOutcomeForSend(attempt.result));
  }
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
 * The confirmation send path (the reminders use sendReminder, which adds
 * the post-claim re-validation a scheduled send needs). Encapsulates:
 *   - consent gate and deployment fence
 *   - claim
 *   - Twilio POST with its ledger row (sendWithLedgerRow)
 *   - record_sms_result in finally
 *   - then the best-effort ledger settle (settleLedgerRow)
 *   - structured failure log
 *
 * Returns ok / skipped / error in a shape the caller can ignore
 * without breaking the booking or reschedule flow.
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

  // SMS-00: a deployment that may not send (a Vercel preview) skips BEFORE the
  // claim, so it neither spends an attempt nor reports a provider failure --
  // and an ops alert -- for a message it was never allowed to send.
  // sendSmsSafely refuses as well; this keeps that refusal silent here.
  const fence = outboundSmsFence();
  if (!fence.allowed) {
    return { ok: false, skipped: true, reason: fence.reason };
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
  let attempt: LedgeredAttempt | null = null;

  try {
    const body = args.buildBody(gate.normalizedPhone);
    const to = args.to(gate.normalizedPhone);
    attempt = await sendWithLedgerRow({
      admin: args.admin,
      studioId: args.studio.id,
      appointmentId: args.appointmentId,
      smsType: args.smsType,
      to,
      body,
    });
    const result = attempt.result;
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
        // PR #155: stamp studio_id on the resulting ops_alerts row so
        // the operator can filter alerts by studio. PR #153 already
        // accepted studioId as optional but the appointment SMS path
        // was not threading it through. studio.id is always available
        // because the SMS input types Pick "id" since PR #155.
        studioId: args.studio.id ?? null,
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
      // PR #155: stamp studio_id (see comment on the result-failure
      // branch above).
      studioId: args.studio.id ?? null,
    });
  } finally {
    await recordSmsResult(
      args.admin,
      args.appointmentId,
      args.smsType,
      success,
    );
  }
  // Only after the authoritative record: the best-effort ledger settle.
  if (attempt) await settleLedgerRow(args.admin, attempt);

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

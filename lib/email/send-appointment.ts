import type { SupabaseClient } from "@supabase/supabase-js";
import { FROM_ADDRESS, resend } from "@/lib/email/client";
import {
  buildClientConfirmationEmail,
  buildPractitionerNotificationEmail,
  buildCancellationEmail,
} from "@/lib/email/templates/appointment";
import {
  build24hReminderEmail,
  build2hReminderEmail,
  buildNoShowFollowupEmail,
} from "@/lib/email/templates/reminders";
import { buildPostcareEmail } from "@/lib/email/templates/postcare";
import { buildIntakeRequestEmail } from "@/lib/email/templates/intake-request";
import { buildIcs } from "@/lib/booking/ical";
import type { Appointment, Service, Studio } from "@/lib/types/database";

type AnyAppointment = Appointment;

// Typed delivery result so call sites can stamp DB columns conditionally.
// Replaces the old safeSend() void return that silently swallowed Resend
// errors. Callers MUST inspect `ok` before treating a send as delivered.
export type EmailSendResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string; retryable: boolean };

const RESEND_TIMEOUT_MS = 15_000;

type RawResendError = {
  statusCode?: number;
  name?: string;
  message?: string;
};

// Inspect Resend's error envelope and decide whether to retry. Default
// to retryable=true when the shape is unfamiliar so we don't give up on
// transient network blips.
function classifyResendError(err: RawResendError): {
  message: string;
  retryable: boolean;
} {
  const message = err.message ?? err.name ?? "Unknown Resend error";
  const status = err.statusCode;
  if (typeof status === "number") {
    if (status === 429) return { message, retryable: true };
    if (status >= 500) return { message, retryable: true };
    if (status >= 400) return { message, retryable: false };
  }
  // Specific Resend error names that we know are non-retryable.
  if (
    err.name === "validation_error" ||
    err.name === "invalid_to_address" ||
    err.name === "missing_required_field"
  ) {
    return { message, retryable: false };
  }
  return { message, retryable: true };
}

export async function sendEmailSafely(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  icsContent?: string;
}): Promise<EmailSendResult> {
  if (!resend) {
    return {
      ok: false,
      error: "Resend not configured (RESEND_API_KEY missing)",
      retryable: false,
    };
  }

  if (!opts.to || !opts.to.includes("@")) {
    return {
      ok: false,
      error: `Invalid recipient: ${opts.to || "(empty)"}`,
      retryable: false,
    };
  }

  const payload: Parameters<typeof resend.emails.send>[0] = {
    from: FROM_ADDRESS,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  };
  if (opts.icsContent) {
    payload.attachments = [
      {
        filename: "appointment.ics",
        content: Buffer.from(opts.icsContent, "utf8"),
      },
    ];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  try {
    // The Resend SDK doesn't accept an AbortSignal directly, so we race
    // its promise against a manually-rejected timer. Whichever resolves
    // first wins; the loser is ignored.
    const sendPromise = resend.emails.send(payload);
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () =>
        reject(new Error("__timeout__")),
      );
    });
    const result = (await Promise.race([sendPromise, timeoutPromise])) as
      | { data: { id?: string } | null; error: RawResendError | null }
      | undefined;
    clearTimeout(timeout);

    if (!result) {
      return { ok: false, error: "Empty response from Resend", retryable: true };
    }
    if (result.error) {
      const c = classifyResendError(result.error);
      return { ok: false, error: c.message, retryable: c.retryable };
    }
    return { ok: true, messageId: result.data?.id };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.message === "__timeout__") {
      return {
        ok: false,
        error: `Resend timeout after ${RESEND_TIMEOUT_MS}ms`,
        retryable: true,
      };
    }
    const message = err instanceof Error ? err.message : "Unknown send error";
    // Network errors throw synchronously / asynchronously and rarely
    // carry structured shape; treat as retryable.
    return { ok: false, error: message, retryable: true };
  }
}

export type EmailType =
  | "confirmation"
  | "reminder_24h"
  | "reminder_2h"
  | "no_show";

// Atomic single-statement DB update via the record_email_attempt RPC
// (migration 0028). Increments the matching _send_attempts column AND
// stamps _sent_at only when success is true. Both branches share the
// same code path so we can't accidentally double-increment.
//
// We don't backfill or null out *_sent_at columns populated by the old
// (broken) safeSend code path. This fix applies to all new sends going
// forward. A separate optional SQL block in migration 0028 resets
// stuck attempt counters for future-dated appointments only.
export async function recordEmailAttempt(
  admin: SupabaseClient,
  appointmentId: string,
  emailType: EmailType,
  success: boolean,
): Promise<void> {
  const { error } = await admin.rpc("record_email_attempt", {
    p_appointment_id: appointmentId,
    p_email_type: emailType,
    p_success: success,
  });
  if (error) {
    console.error(
      JSON.stringify({
        event: "record_email_attempt_failed",
        appointmentId,
        emailType,
        success,
        error: String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

// PR #189 (pilot safety). Email types covered by the claim_email_send
// RPC (migration 0080). no_show keeps the unclaimed 0028 path;
// postcare has its own conditional-UPDATE claim (0043).
export type ClaimableEmailType = "confirmation" | "reminder_24h" | "reminder_2h";

// Atomically reserve the right to send one email of the given type
// for the given appointment (claim_email_send, migration 0080).
// Returns true when this process won the claim and should call
// Resend. Mirrors claimSmsSend (lib/sms/send-appointment.ts): the
// claim increments _send_attempts and stamps _claimed_at in one
// statement, so two overlapping cron runs can never both send.
// Errors are treated as "claim not won" so an RPC outage cannot
// cause a duplicate send.
export async function claimEmailSend(
  admin: SupabaseClient,
  appointmentId: string,
  emailType: ClaimableEmailType,
): Promise<boolean> {
  const { data, error } = await admin.rpc("claim_email_send", {
    p_appointment_id: appointmentId,
    p_email_type: emailType,
  });
  if (error) {
    console.error(
      JSON.stringify({
        event: "claim_email_send_failed",
        appointmentId,
        emailType,
        error: String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
  return data === true;
}

// Record the outcome of a CLAIMED send (record_email_result,
// migration 0080): success stamps _sent_at, both branches clear
// _claimed_at. Does NOT increment attempts; claimEmailSend already
// did. Unclaimed call sites keep using recordEmailAttempt above.
export async function recordEmailResult(
  admin: SupabaseClient,
  appointmentId: string,
  emailType: ClaimableEmailType,
  success: boolean,
): Promise<void> {
  const { error } = await admin.rpc("record_email_result", {
    p_appointment_id: appointmentId,
    p_email_type: emailType,
    p_success: success,
  });
  if (error) {
    // Do not throw. A failure here leaves the claim in place; the
    // 5-minute staleness window in claim_email_send bounds how long
    // the row stays blocked, and _sent_at remaining null means the
    // next pass may retry under the attempts cap.
    console.error(
      JSON.stringify({
        event: "record_email_result_failed",
        appointmentId,
        emailType,
        success,
        error: String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

// PR #153. Threshold used to surface a final-failure ops alert.
// Matches MAX_ATTEMPTS in /api/cron/appointment-reminders/route.ts
// (which also caps retries at 3). Importing that constant would
// create a cyclic dependency; the documented contract is "three
// strikes". A future refactor can move the threshold into a single
// shared source.
const EMAIL_GIVE_UP_ATTEMPT_THRESHOLD = 3;

export function logEmailFailure(opts: {
  appointmentId: string;
  emailType: EmailType;
  error: string;
  retryable: boolean;
  attemptNumber?: number;
  // PR #153. Optional studio id surfaces on the ops alert so the
  // operator can filter by studio. Cron paths that already have
  // the studio on the appointment join should pass it; legacy
  // call sites can omit and fall back to studio_id=null on the
  // alert row.
  studioId?: string | null;
}): void {
  console.error(
    JSON.stringify({
      event: "email_send_failed",
      appointmentId: opts.appointmentId,
      emailType: opts.emailType,
      error: opts.error,
      retryable: opts.retryable,
      attemptNumber: opts.attemptNumber,
      timestamp: new Date().toISOString(),
    }),
  );
  // PR #153. Record a durable ops alert ONLY when the attempt was
  // the final one (3-strike cap reached or marked non-retryable).
  // Lower-numbered retryable attempts are normal noise and stay
  // log-only. Operator email is deferred in PR #153, so the alert
  // is DB + structured log only; no recursion path back through
  // this email helper exists.
  const isFinalAttempt =
    !opts.retryable ||
    (typeof opts.attemptNumber === "number" &&
      opts.attemptNumber >= EMAIL_GIVE_UP_ATTEMPT_THRESHOLD);
  if (!isFinalAttempt) return;
  // Fire-and-forget; the helper never throws to the caller.
  void (async () => {
    try {
      const { recordOpsAlert } = await import("@/lib/ops/alerts");
      await recordOpsAlert({
        severity: "warning",
        event: "email_send_gave_up",
        message: `Email ${opts.emailType} gave up after ${opts.attemptNumber ?? "?"} attempts.`,
        studioId: opts.studioId ?? null,
        appointmentId: opts.appointmentId,
        route: "lib/email/send-appointment",
        safeDetails: {
          email_type: opts.emailType,
          attempt_number: opts.attemptNumber ?? null,
          retryable: opts.retryable,
          provider_error: opts.error,
        },
      });
    } catch {
      // recordOpsAlert is itself try/catch'd. Swallow anything
      // exotic here so the email-send call site never sees an
      // alerting exception.
    }
  })();
}

export async function sendBookingConfirmationToClient(params: {
  appointment: AnyAppointment;
  service: Pick<
    Service,
    "name" | "default_duration_minutes" | "pre_care_instructions"
  > | null;
  studio: Studio;
  practitionerDisplayName: string | null;
  clientName: string;
  clientEmail: string;
  cancellationUrl: string;
  rescheduleUrl: string | null;
  intakeUrl: string | null;
  treatmentTimeLine: string | null;
  appBaseUrl: string;
}): Promise<EmailSendResult> {
  if (!params.clientEmail) {
    return { ok: false, error: "No client email on file", retryable: false };
  }
  const start = new Date(params.appointment.starts_at);
  const end = new Date(params.appointment.ends_at);
  const serviceName = params.service?.name ?? "Appointment";
  const { subject, html, text } = buildClientConfirmationEmail({
    clientName: params.clientName,
    studioName: params.studio.name,
    studioAddress: params.studio.address,
    studioEmail: params.studio.owner_email,
    practitionerName: params.practitionerDisplayName,
    serviceName,
    durationMinutes: params.appointment.duration_minutes,
    startsAt: start,
    endsAt: end,
    timezone: params.studio.timezone,
    cancellationUrl: params.cancellationUrl,
    rescheduleUrl: params.rescheduleUrl,
    intakeUrl: params.intakeUrl,
    preCareInstructions: params.service?.pre_care_instructions ?? null,
    treatmentTimeLine: params.treatmentTimeLine,
  });

  const ics = buildIcs({
    uid: params.appointment.id,
    start,
    end,
    summary: `${serviceName} · ${params.studio.name}`,
    location: params.studio.address ?? undefined,
    description:
      `${serviceName} at ${params.studio.name}.\nCancel: ${params.cancellationUrl}`,
    organizerName: params.studio.name,
    organizerEmail: params.studio.owner_email,
    attendeeName: params.clientName,
    attendeeEmail: params.clientEmail,
  });

  return sendEmailSafely({
    to: params.clientEmail,
    subject,
    html,
    text,
    icsContent: ics,
  });
}

export async function sendBookingNotificationToPractitioner(params: {
  appointment: AnyAppointment;
  service: Pick<Service, "name"> | null;
  studio: Studio;
  practitionerName: string;
  practitionerEmail: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  notes: string | null;
  appointmentUrl: string;
  // PR #163. Practitioner-facing display string for "How did you
  // hear about us?". Already mapped through referralSourceLabel by
  // the caller (the public booking action) so this helper does not
  // need to know about the canonical option set.
  referralSourceLabel: string | null;
}) {
  if (!params.practitionerEmail) return;
  const start = new Date(params.appointment.starts_at);
  const end = new Date(params.appointment.ends_at);
  const { subject, html, text } = buildPractitionerNotificationEmail({
    practitionerName: params.practitionerName,
    clientName: params.clientName,
    clientEmail: params.clientEmail,
    clientPhone: params.clientPhone,
    studioName: params.studio.name,
    serviceName: params.service?.name ?? "Appointment",
    startsAt: start,
    endsAt: end,
    timezone: params.studio.timezone,
    notes: params.notes,
    appointmentUrl: params.appointmentUrl,
    referralSourceLabel: params.referralSourceLabel,
  });
  await sendEmailSafely({
    to: params.practitionerEmail,
    subject,
    html,
    text,
  });
}

export async function sendCancellationEmail(params: {
  to: string;
  recipientName: string;
  studio: Studio;
  serviceName: string;
  startsAt: Date;
  cancelledBy: "client" | "practitioner" | "owner";
  reason: string | null;
  isClient: boolean;
  rebookUrl?: string;
}) {
  if (!params.to) return;
  const { subject, html, text } = buildCancellationEmail({
    recipientName: params.recipientName,
    studioName: params.studio.name,
    serviceName: params.serviceName,
    startsAt: params.startsAt,
    timezone: params.studio.timezone,
    cancelledBy: params.cancelledBy,
    reason: params.reason,
    isClient: params.isClient,
    rebookUrl: params.rebookUrl,
  });
  await sendEmailSafely({
    to: params.to,
    subject,
    html,
    text,
  });
}

type ReminderInput = {
  appointment: AnyAppointment;
  service: Pick<
    Service,
    "name" | "default_duration_minutes" | "pre_care_instructions"
  > | null;
  studio: Studio;
  practitionerDisplayName: string | null;
  clientName: string;
  clientEmail: string;
  cancellationUrl: string;
  rescheduleUrl: string | null;
  treatmentTimeLine: string | null;
};

export async function send24hReminderToClient(
  p: ReminderInput,
): Promise<EmailSendResult> {
  if (!p.clientEmail) {
    return { ok: false, error: "No client email on file", retryable: false };
  }
  const start = new Date(p.appointment.starts_at);
  const end = new Date(p.appointment.ends_at);
  const { subject, html, text } = build24hReminderEmail({
    clientName: p.clientName,
    studioName: p.studio.name,
    studioAddress: p.studio.address,
    practitionerName: p.practitionerDisplayName,
    serviceName: p.service?.name ?? "Appointment",
    durationMinutes: p.appointment.duration_minutes,
    startsAt: start,
    endsAt: end,
    timezone: p.studio.timezone,
    cancellationUrl: p.cancellationUrl,
    rescheduleUrl: p.rescheduleUrl,
    preCareInstructions: p.service?.pre_care_instructions ?? null,
    treatmentTimeLine: p.treatmentTimeLine,
  });
  return sendEmailSafely({ to: p.clientEmail, subject, html, text });
}

export async function send2hReminderToClient(
  p: ReminderInput,
): Promise<EmailSendResult> {
  if (!p.clientEmail) {
    return { ok: false, error: "No client email on file", retryable: false };
  }
  const start = new Date(p.appointment.starts_at);
  const end = new Date(p.appointment.ends_at);
  const { subject, html, text } = build2hReminderEmail({
    clientName: p.clientName,
    studioName: p.studio.name,
    studioAddress: p.studio.address,
    practitionerName: p.practitionerDisplayName,
    serviceName: p.service?.name ?? "Appointment",
    durationMinutes: p.appointment.duration_minutes,
    startsAt: start,
    endsAt: end,
    timezone: p.studio.timezone,
    cancellationUrl: p.cancellationUrl,
    rescheduleUrl: p.rescheduleUrl,
    preCareInstructions: p.service?.pre_care_instructions ?? null,
    treatmentTimeLine: p.treatmentTimeLine,
  });
  return sendEmailSafely({ to: p.clientEmail, subject, html, text });
}

export async function sendNoShowFollowupToClient(params: {
  clientName: string;
  clientEmail: string;
  studio: Studio;
  rebookUrl: string | null;
}): Promise<EmailSendResult> {
  if (!params.clientEmail) {
    return { ok: false, error: "No client email on file", retryable: false };
  }
  const { subject, html, text } = buildNoShowFollowupEmail({
    clientName: params.clientName,
    studioName: params.studio.name,
    rebookUrl: params.rebookUrl,
  });
  return sendEmailSafely({ to: params.clientEmail, subject, html, text });
}


// Postcare email sender (manual practitioner-triggered, v1). Pure
// renderer-around-template: takes already-loaded studio + appointment
// + service context and dispatches via Resend. Bookkeeping (sent_at +
// send_attempts) is intentionally handled by the calling action via a
// single conditional UPDATE that serves as both the first-send atomic
// claim AND the attempts increment. record_email_attempt is NOT used
// for postcare because its set-sent_at-only-on-success semantic cannot
// be combined atomically with a first-send race-protection claim; see
// the audit + commit message for the trade-off.
export async function sendPostcareToClient(params: {
  clientName: string;
  clientEmail: string;
  studio: Studio;
  practitionerName: string | null;
  serviceName: string | null;
  startsAt: Date | null;
  aftercareText: string | null;
  warningSignsText: string | null;
  productRecommendationsText: string | null;
  reviewUrl: string | null;
  reviewPromptText: string | null;
}): Promise<EmailSendResult> {
  if (!params.clientEmail) {
    return { ok: false, error: "No client email on file", retryable: false };
  }
  // Contact-line priority: studios.postcare_contact_email overrides
  // studios.owner_email when set. Never the client's email; if
  // neither is set we pass null and the template omits the line
  // entirely (no "Contact: undefined"). The PostcareSettingsForm UI
  // surfaces the same fallback to the practitioner.
  const studioContactEmail = postcareContactEmail(params.studio);
  const { subject, html, text } = buildPostcareEmail({
    clientName: params.clientName,
    studioName: params.studio.name,
    studioEmail: studioContactEmail,
    practitionerName: params.practitionerName,
    serviceName: params.serviceName,
    startsAt: params.startsAt,
    timezone: params.studio.timezone,
    aftercareText: params.aftercareText,
    warningSignsText: params.warningSignsText,
    productRecommendationsText: params.productRecommendationsText,
    reviewUrl: params.reviewUrl,
    reviewPromptText: params.reviewPromptText,
  });
  return sendEmailSafely({ to: params.clientEmail, subject, html, text });
}

// Resolve which email to render in the postcare Contact line. The
// preview and the real send share this helper so they never diverge.
// Returns null when neither value is usable; the template suppresses
// the Contact line in that case.
export function postcareContactEmail(
  studio: Pick<Studio, "postcare_contact_email" | "owner_email">,
): string | null {
  const override = studio.postcare_contact_email?.trim();
  if (override && override.length > 0) return override;
  const fallback = studio.owner_email?.trim();
  if (fallback && fallback.length > 0) return fallback;
  return null;
}

// Practitioner-triggered intake reissue email. Sent when the
// practitioner clicks "Request intake update" (or "Resend email" on
// an existing in-progress row) from the client profile. Independent
// of the booking-confirmation flow; carries only the secure tokenized
// link plus a neutral one-line ask. Failure is surfaced to the
// practitioner UI; no DB bookkeeping (no record_email_attempt
// equivalent for this surface today).
export async function sendIntakeUpdateRequestToClient(params: {
  clientEmail: string;
  studioName: string;
  intakeUrl: string;
}): Promise<EmailSendResult> {
  if (!params.clientEmail) {
    return { ok: false, error: "No client email on file", retryable: false };
  }
  const { subject, html, text } = buildIntakeRequestEmail({
    studioName: params.studioName,
    intakeUrl: params.intakeUrl,
  });
  return sendEmailSafely({ to: params.clientEmail, subject, html, text });
}

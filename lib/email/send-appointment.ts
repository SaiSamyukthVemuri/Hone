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

export function logEmailFailure(opts: {
  appointmentId: string;
  emailType: EmailType;
  error: string;
  retryable: boolean;
  attemptNumber?: number;
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
}): Promise<EmailSendResult> {
  if (!params.clientEmail) {
    return { ok: false, error: "No client email on file", retryable: false };
  }
  const { subject, html, text } = buildPostcareEmail({
    clientName: params.clientName,
    studioName: params.studio.name,
    studioEmail: params.studio.owner_email,
    practitionerName: params.practitionerName,
    serviceName: params.serviceName,
    startsAt: params.startsAt,
    timezone: params.studio.timezone,
    aftercareText: params.aftercareText,
    warningSignsText: params.warningSignsText,
    productRecommendationsText: params.productRecommendationsText,
    reviewUrl: params.reviewUrl,
  });
  return sendEmailSafely({ to: params.clientEmail, subject, html, text });
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

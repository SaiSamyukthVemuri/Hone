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
import { buildIcs } from "@/lib/booking/ical";
import type { Appointment, Service, Studio } from "@/lib/types/database";

type AnyAppointment = Appointment;

async function safeSend(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  icsContent?: string;
}): Promise<void> {
  if (!resend) {
    console.warn("Resend client not configured; skipping send.", opts.subject);
    return;
  }
  try {
    const payload: Parameters<typeof resend.emails.send>[0] = {
      from: FROM_ADDRESS,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    };
    if (opts.icsContent) {
      // Resend accepts a Buffer or base64 string for attachment content.
      payload.attachments = [
        {
          filename: "appointment.ics",
          content: Buffer.from(opts.icsContent, "utf8"),
        },
      ];
    }
    const { error } = await resend.emails.send(payload);
    if (error) {
      console.error("Failed to send appointment email:", error);
    }
  } catch (err) {
    console.error("Failed to send appointment email:", err);
  }
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
}) {
  if (!params.clientEmail) return;
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

  await safeSend({
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
  await safeSend({
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
  await safeSend({
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

export async function send24hReminderToClient(p: ReminderInput): Promise<void> {
  if (!p.clientEmail) return;
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
  await safeSend({ to: p.clientEmail, subject, html, text });
}

export async function send2hReminderToClient(p: ReminderInput): Promise<void> {
  if (!p.clientEmail) return;
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
  await safeSend({ to: p.clientEmail, subject, html, text });
}

export async function sendNoShowFollowupToClient(params: {
  clientName: string;
  clientEmail: string;
  studio: Studio;
  rebookUrl: string | null;
}): Promise<void> {
  if (!params.clientEmail) return;
  const { subject, html, text } = buildNoShowFollowupEmail({
    clientName: params.clientName,
    studioName: params.studio.name,
    rebookUrl: params.rebookUrl,
  });
  await safeSend({ to: params.clientEmail, subject, html, text });
}

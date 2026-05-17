import { FROM_ADDRESS, resend } from "@/lib/email/client";
import {
  buildClientConfirmationEmail,
  buildPractitionerNotificationEmail,
  buildCancellationEmail,
} from "@/lib/email/templates/appointment";
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
  service: Pick<Service, "name" | "default_duration_minutes"> | null;
  studio: Studio;
  practitionerDisplayName: string | null;
  clientName: string;
  clientEmail: string;
  cancellationUrl: string;
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
  });

  const ics = buildIcs({
    uid: params.appointment.id,
    start,
    end,
    summary: `${serviceName} — ${params.studio.name}`,
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

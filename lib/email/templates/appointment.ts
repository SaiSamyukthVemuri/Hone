import { localDateString, localTimeString } from "@/lib/booking/tz";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dayLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function rangeLabel(start: Date, end: Date, tz: string): string {
  return `${localTimeString(start, tz)} – ${localTimeString(end, tz)}`;
}

const PREP_INSTRUCTIONS =
  "Please arrive 5 minutes early. Wear comfortable clothing. Avoid caffeine before your appointment.";

type ConfirmationToClient = {
  clientName: string;
  studioName: string;
  studioAddress: string | null;
  studioEmail: string;
  practitionerName: string | null;
  serviceName: string;
  durationMinutes: number;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  cancellationUrl: string;
};

export function buildClientConfirmationEmail(p: ConfirmationToClient): {
  subject: string;
  html: string;
  text: string;
} {
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = rangeLabel(p.startsAt, p.endsAt, p.timezone);
  const subject = `Appointment confirmed: ${p.serviceName} with ${p.studioName} on ${dayStr}`;
  const safeClient = escapeHtml(p.clientName);
  const safeStudio = escapeHtml(p.studioName);
  const safeService = escapeHtml(p.serviceName);
  const safePract = p.practitionerName ? escapeHtml(p.practitionerName) : null;
  const safeAddress = p.studioAddress ? escapeHtml(p.studioAddress) : null;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          Your appointment is confirmed.
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          ${safeClient},
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          You're booked for <strong>${safeService}</strong>${safePract ? ` with ${safePract}` : ""} at <strong>${safeStudio}</strong>.
        </td></tr>
        <tr><td style="padding-bottom:24px; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; padding-top:24px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.8;">
          <strong>${escapeHtml(dayStr)}</strong><br/>
          ${escapeHtml(timeStr)} (${escapeHtml(p.timezone)})<br/>
          Duration: ${p.durationMinutes} minutes
          ${safeAddress ? `<br/><br/>${safeAddress}` : ""}
        </td></tr>
        <tr><td style="padding:24px 0; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.65; color:#6B6B6B;">
          ${escapeHtml(PREP_INSTRUCTIONS)}
        </td></tr>
        <tr><td style="padding-bottom:32px;">
          <a href="${p.cancellationUrl}" style="font-family:-apple-system, system-ui, sans-serif; font-size:13px; color:#0A0A0A; letter-spacing:0.1em; text-transform:uppercase;">
            Cancel this appointment
          </a>
        </td></tr>
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          Hone &middot; Charting software for electrolysis and laser practitioners
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${p.clientName},

Your appointment is confirmed.

${p.serviceName}${p.practitionerName ? ` with ${p.practitionerName}` : ""} at ${p.studioName}

${dayStr}
${timeStr} (${p.timezone})
Duration: ${p.durationMinutes} minutes
${p.studioAddress ? `\n${p.studioAddress}\n` : ""}
${PREP_INSTRUCTIONS}

Need to cancel? ${p.cancellationUrl}

Hone. Charting software for electrolysis and laser practitioners.
hone.care
`;

  return { subject, html, text };
}

type NotifyPractitioner = {
  practitionerName: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  studioName: string;
  serviceName: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  notes: string | null;
  appointmentUrl: string;
};

export function buildPractitionerNotificationEmail(p: NotifyPractitioner): {
  subject: string;
  html: string;
  text: string;
} {
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = rangeLabel(p.startsAt, p.endsAt, p.timezone);
  const subject = `New booking: ${p.clientName} – ${p.serviceName} on ${dayStr}`;
  const safeClient = escapeHtml(p.clientName);
  const safeService = escapeHtml(p.serviceName);
  const safePract = escapeHtml(p.practitionerName);
  const safeStudio = escapeHtml(p.studioName);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:24px; letter-spacing:-0.02em; line-height:1.2;">
          New booking at ${safeStudio}.
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;">
          ${safePract},
        </td></tr>
        <tr><td style="padding-bottom:24px; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; padding-top:24px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.8;">
          <strong>${safeClient}</strong><br/>
          ${escapeHtml(p.clientEmail)}${p.clientPhone ? ` &middot; ${escapeHtml(p.clientPhone)}` : ""}<br/><br/>
          ${safeService}<br/>
          <strong>${escapeHtml(dayStr)}</strong><br/>
          ${escapeHtml(timeStr)} (${escapeHtml(p.timezone)})
          ${p.notes ? `<br/><br/>Notes: ${escapeHtml(p.notes)}` : ""}
        </td></tr>
        <tr><td style="padding-top:24px;">
          <a href="${p.appointmentUrl}" style="font-family:-apple-system, system-ui, sans-serif; font-size:13px; color:#0A0A0A; letter-spacing:0.1em; text-transform:uppercase;">
            Open in Hone
          </a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `New booking at ${p.studioName}.

${p.clientName}
${p.clientEmail}${p.clientPhone ? `, ${p.clientPhone}` : ""}

${p.serviceName}
${dayStr}
${timeStr} (${p.timezone})
${p.notes ? `\nNotes: ${p.notes}\n` : ""}
Open in Hone: ${p.appointmentUrl}
`;

  return { subject, html, text };
}

type CancellationEmail = {
  recipientName: string;
  studioName: string;
  serviceName: string;
  startsAt: Date;
  timezone: string;
  cancelledBy: "client" | "practitioner" | "owner";
  reason: string | null;
  isClient: boolean; // recipient is the client
  rebookUrl?: string;
};

export function buildCancellationEmail(p: CancellationEmail): {
  subject: string;
  html: string;
  text: string;
} {
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = localTimeString(p.startsAt, p.timezone);
  const subject = p.isClient
    ? `Appointment cancelled: ${p.serviceName} at ${p.studioName}`
    : `Appointment cancelled: ${p.recipientName === p.studioName ? "" : `${p.recipientName} — `}${p.serviceName} on ${dayStr}`;
  const safeName = escapeHtml(p.recipientName);
  const safeStudio = escapeHtml(p.studioName);
  const safeService = escapeHtml(p.serviceName);
  const lead = p.isClient
    ? `Your ${safeService} appointment at ${safeStudio} on <strong>${escapeHtml(dayStr)}</strong> at ${escapeHtml(timeStr)} has been cancelled${p.cancelledBy !== "client" ? " by the studio" : ""}.`
    : `${safeService} on <strong>${escapeHtml(dayStr)}</strong> at ${escapeHtml(timeStr)} was cancelled by the ${p.cancelledBy}.`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:24px; letter-spacing:-0.02em; line-height:1.2;">
          Appointment cancelled.
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;">${safeName},</td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;">
          ${lead}
          ${p.reason ? `<br/><br/>Reason: ${escapeHtml(p.reason)}` : ""}
        </td></tr>
        ${
          p.isClient && p.rebookUrl
            ? `<tr><td style="padding-bottom:32px;">
                <a href="${p.rebookUrl}" style="font-family:-apple-system, system-ui, sans-serif; font-size:13px; color:#0A0A0A; letter-spacing:0.1em; text-transform:uppercase;">
                  Book another appointment
                </a>
              </td></tr>`
            : ""
        }
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${p.recipientName},

${p.isClient ? `Your ${p.serviceName} appointment at ${p.studioName} on ${dayStr} at ${timeStr} has been cancelled${p.cancelledBy !== "client" ? " by the studio" : ""}.` : `${p.serviceName} on ${dayStr} at ${timeStr} was cancelled by the ${p.cancelledBy}.`}
${p.reason ? `\nReason: ${p.reason}` : ""}
${p.isClient && p.rebookUrl ? `\nBook another: ${p.rebookUrl}` : ""}
`;

  return { subject, html, text };
}

import { localTimeString12h } from "@/lib/booking/tz";

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

// PR #157 patch. This helper is the source of the reported bug:
// `${localTimeString(start)} to ${localTimeString(end)}` produced
// "11:00 to 12:00" (24h, no AM/PM), which a recipient on mobile
// read as the ambiguous "11 to 12". Switched both ends to the 12h
// client-facing helper so the body now reads "11:00 AM to 12:00 PM".
function rangeLabel(start: Date, end: Date, tz: string): string {
  return `${localTimeString12h(start, tz)} to ${localTimeString12h(end, tz)}`;
}

type ReminderProps = {
  clientName: string;
  studioName: string;
  studioAddress: string | null;
  practitionerName: string | null;
  serviceName: string;
  durationMinutes: number;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  cancellationUrl: string;
  rescheduleUrl: string | null;
  preCareInstructions: string | null;
  treatmentTimeLine: string | null;
};

function reminderHtml(opts: {
  headline: string;
  lead: string;
  subject: string;
  p: ReminderProps;
}): string {
  const { headline, lead, p } = opts;
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = rangeLabel(p.startsAt, p.endsAt, p.timezone);
  const safeClient = escapeHtml(p.clientName);
  const safeStudio = escapeHtml(p.studioName);
  const safeService = escapeHtml(p.serviceName);
  const safePract = p.practitionerName ? escapeHtml(p.practitionerName) : null;
  const safeAddress = p.studioAddress ? escapeHtml(p.studioAddress) : null;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(opts.subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          ${escapeHtml(headline)}
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          Hi ${safeClient},
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          ${escapeHtml(lead)}
        </td></tr>
        <tr><td style="padding-bottom:24px; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; padding-top:24px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.8;">
          <strong>${safeService}</strong>${safePract ? ` with ${safePract}` : ""} at <strong>${safeStudio}</strong><br/>
          <strong>${escapeHtml(dayStr)}</strong><br/>
          ${escapeHtml(timeStr)} (${escapeHtml(p.timezone)})<br/>
          Duration: ${p.durationMinutes} minutes
          ${safeAddress ? `<br/><br/>${safeAddress}` : ""}
          ${p.treatmentTimeLine ? `<br/><br/><span style="font-family:Georgia, serif; font-style:italic; color:#6B6B6B;">${escapeHtml(p.treatmentTimeLine)}</span>` : ""}
        </td></tr>
        ${
          p.preCareInstructions
            ? `<tr><td style="padding:20px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F1EA; border-left:3px solid #C9C4B6;">
                  <tr><td style="padding:16px 20px;">
                    <p style="margin:0 0 8px 0; font-family:-apple-system, system-ui, sans-serif; font-size:11px; font-weight:600; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">Before your appointment</p>
                    <p style="margin:0; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; white-space:pre-wrap;">${escapeHtml(p.preCareInstructions)}</p>
                  </td></tr>
                </table>
              </td></tr>`
            : ""
        }
        <tr><td style="padding:24px 0 32px 0;">
          ${
            p.rescheduleUrl
              ? `<a href="${p.rescheduleUrl}" style="display:inline-block; padding:12px 20px; margin-right:12px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px;">Reschedule</a>`
              : ""
          }
          <a href="${p.cancellationUrl}" style="font-family:-apple-system, system-ui, sans-serif; font-size:13px; color:#0A0A0A; letter-spacing:0.1em; text-transform:uppercase;">
            Cancel
          </a>
        </td></tr>
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          ${safeStudio} via Hone
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function reminderText(opts: {
  headline: string;
  lead: string;
  p: ReminderProps;
}): string {
  const { headline, lead, p } = opts;
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = rangeLabel(p.startsAt, p.endsAt, p.timezone);
  return `${headline}

Hi ${p.clientName},

${lead}

${p.serviceName}${p.practitionerName ? ` with ${p.practitionerName}` : ""} at ${p.studioName}
${dayStr}
${timeStr} (${p.timezone})
Duration: ${p.durationMinutes} minutes
${p.studioAddress ? `\n${p.studioAddress}\n` : ""}
${p.treatmentTimeLine ? `\n${p.treatmentTimeLine}\n` : ""}
${p.preCareInstructions ? `\nBefore your appointment:\n${p.preCareInstructions}\n` : ""}
${p.rescheduleUrl ? `Reschedule: ${p.rescheduleUrl}\n` : ""}
Cancel: ${p.cancellationUrl}
`;
}

export function build24hReminderEmail(p: ReminderProps): {
  subject: string;
  html: string;
  text: string;
} {
  // PR #157 patch. Subject line carries the appointment start time;
  // recipient sees it in the inbox preview before opening the email.
  // 12h with AM/PM is unambiguous; 24h "11:00" forced a guess.
  const timeStr = localTimeString12h(p.startsAt, p.timezone);
  const subject = `Reminder: ${p.serviceName} tomorrow at ${timeStr}`;
  const headline = "Your appointment is tomorrow.";
  const lead =
    "This is a reminder that you have an appointment with us tomorrow.";
  return {
    subject,
    html: reminderHtml({ headline, lead, subject, p }),
    text: reminderText({ headline, lead, p }),
  };
}

export function build2hReminderEmail(p: ReminderProps): {
  subject: string;
  html: string;
  text: string;
} {
  // PR #157 patch. Same 12h subject-line fix as the 24h reminder.
  const timeStr = localTimeString12h(p.startsAt, p.timezone);
  const subject = `Reminder: ${p.serviceName} today at ${timeStr}`;
  const headline = "See you soon.";
  const lead = "Your appointment is in about 2 hours.";
  return {
    subject,
    html: reminderHtml({ headline, lead, subject, p }),
    text: reminderText({ headline, lead, p }),
  };
}

type NoShowFollowupProps = {
  clientName: string;
  studioName: string;
  rebookUrl: string | null;
};

export function buildNoShowFollowupEmail(p: NoShowFollowupProps): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = "We missed you today";
  const safeClient = escapeHtml(p.clientName);
  const safeStudio = escapeHtml(p.studioName);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          We missed you today.
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          Hi ${safeClient},
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          We didn&rsquo;t see you at your appointment today. We hope everything is okay.
        </td></tr>
        ${
          p.rebookUrl
            ? `<tr><td style="padding-bottom:32px;">
                <a href="${p.rebookUrl}" style="display:inline-block; padding:12px 20px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px;">Book another appointment</a>
              </td></tr>`
            : ""
        }
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          ${safeStudio} via Hone
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `Hi ${p.clientName},

We didn't see you at your appointment today. We hope everything is okay.
${p.rebookUrl ? `\nIf you'd like to rebook: ${p.rebookUrl}\n` : ""}
${p.studioName} via Hone
`;

  return { subject, html, text };
}

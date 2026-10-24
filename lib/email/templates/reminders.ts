import { localTimeString12h } from "@/lib/booking/tz";
import {
  INTAKE_CTA_LABEL,
  INTAKE_IGNORE_LINE,
  INTAKE_LINK_FALLBACK_LINE,
  INTAKE_SECTION_COPY,
  type IntakeReminderKind,
  type IntakeSectionCopy,
} from "@/lib/email/templates/intake-reminder";
import { clientPreheader, withPreheader, withTextPreheader } from "@/lib/email/preheader";
import { withReference } from "@/lib/email/subject-reference";
import { arrivalSectionHtml, arrivalSectionText } from "@/lib/email/templates/arrival";

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
  // HON-50. Studio arrival/parking instructions; blank or omitted renders
  // no section (lib/email/templates/arrival.ts).
  arrivalInstructions?: string | null;
  practitionerName: string | null;
  serviceName: string;
  durationMinutes: number;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  cancellationUrl: string;
  rescheduleUrl: string | null;
  // Token-FREE studio portal login URL (/portal/login?studio=slug). NOT a
  // one-time magic link. Optional so non-sender callers can omit it.
  portalLoginUrl?: string | null;
  preCareInstructions: string | null;
  treatmentTimeLine: string | null;
  // A FRESH secure intake link, or null. Non-null ONLY when the studio has
  // intake reminders on AND the client's latest intake was still in_progress
  // at the send decision. Optional (like portalLoginUrl) so the callers and
  // tests that build a plain reminder need no change.
  intakeUrl?: string | null;
  // A short non-sensitive per-booking label (lib/email/booking-reference.ts):
  // one booking's reminders must not thread into another's (Codex 4355360168;
  // tests/lib/email/email-subject-sweep.test.ts).
  bookingReference: string;
};

// PREVIEW RULE (HIPAA-READY-01, #828): a mail client that strips the
// preheader's invisible filler shows the preheader followed by the first body
// text, so the reminder OPENS with a headline and a lead that name only the
// studio. When the appointment is, the client's name and the service follow
// them, out of the preview window. Proved in
// tests/lib/email/preheader-minimum-necessary.test.ts.
function reminderLead(studioName: string): string {
  return `This is a reminder from ${studioName} about your upcoming appointment. The details are below.`;
}

function reminderHtml(opts: {
  headline: string;
  lead: string;
  subject: string;
  p: ReminderProps;
  intake: IntakeSectionCopy | null;
}): string {
  const { headline, lead, p, intake } = opts;
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = rangeLabel(p.startsAt, p.endsAt, p.timezone);
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
          ${escapeHtml(reminderLead(p.studioName))}
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          ${escapeHtml(lead)}
        </td></tr>
        <tr><td style="padding-bottom:24px; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; padding-top:24px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.8;">
          <strong>${safeService}</strong>${safePract ? ` with ${safePract}` : ""} at <strong>${safeStudio}</strong><br/>
          <strong>${escapeHtml(dayStr)}</strong><br/>
          ${escapeHtml(timeStr)} (${escapeHtml(p.timezone)})<br/>
          Duration: ${p.durationMinutes} minutes
          ${safeAddress ? `<br/><br/>${safeAddress}` : ""}${arrivalSectionHtml(p.arrivalInstructions)}
          ${p.treatmentTimeLine ? `<br/><br/><span style="font-family:Georgia, serif; font-style:italic; color:#6B6B6B;">${escapeHtml(p.treatmentTimeLine)}</span>` : ""}
        </td></tr>
        ${
          // PLACEMENT IS A PRIVACY CONSTRAINT, not a layout preference.
          // A client that strips the preheader filler derives preview text
          // from the FIRST visible nodes - brand, headline, lead. Keeping the
          // intake section below the appointment details keeps
          // intake-completion state off the recipient's lock screen while
          // leaving it the first thing read after the facts.
          //
          // THE CAVEAT IS LOAD-BEARING, not politeness. Intake state is read
          // LIVE before the send decision, but the client can still submit
          // between that read and provider delivery - a race the cron cannot
          // close. INTAKE_IGNORE_LINE is what keeps this section truthful when
          // it loses that race, so every branch carrying the CTA must carry it
          // too. Same constant the standalone intake email uses; no second
          // wording exists to drift.
          intake && p.intakeUrl
            ? `<tr><td style="padding:24px 0 0 0; font-family:-apple-system, system-ui, sans-serif; font-size:16px; font-weight:600; line-height:1.5;">
                ${escapeHtml(intake.heading)}
              </td></tr>
              <tr><td style="padding:8px 0 16px 0; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;">
                ${escapeHtml(intake.body)}
              </td></tr>
              <tr><td style="padding-bottom:8px;">
                <a href="${p.intakeUrl}" style="display:inline-block; padding:12px 20px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px;">
                  ${escapeHtml(INTAKE_CTA_LABEL)}
                </a>
              </td></tr>
              <tr><td style="padding-bottom:8px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B;">
                ${escapeHtml(INTAKE_LINK_FALLBACK_LINE)}<br />
                <span style="word-break:break-all;">${escapeHtml(p.intakeUrl)}</span>
              </td></tr>
              <tr><td style="padding-bottom:8px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B;">
                ${escapeHtml(INTAKE_IGNORE_LINE)}
              </td></tr>`
            : ""
        }
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
        ${
          p.portalLoginUrl
            ? `<tr><td style="padding:20px 0; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; color:#0A0A0A;">
          View your forms, appointments, and care instructions in your <a href="${p.portalLoginUrl}" style="color:#0A0A0A; text-decoration:underline;">secure client portal</a>.
        </td></tr>`
            : ""
        }
        <tr><td style="padding-bottom:16px; font-family:-apple-system, system-ui, sans-serif; font-size:12px; color:#6B6B6B;">
          Booking reference: ${escapeHtml(p.bookingReference.trim())}
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
  intake: IntakeSectionCopy | null;
}): string {
  const { headline, lead, p, intake } = opts;
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = rangeLabel(p.startsAt, p.endsAt, p.timezone);
  return `${headline}

${reminderLead(p.studioName)}

${lead}

${p.serviceName}${p.practitionerName ? ` with ${p.practitionerName}` : ""} at ${p.studioName}
${dayStr}
${timeStr} (${p.timezone})
Duration: ${p.durationMinutes} minutes
${p.studioAddress ? `\n${p.studioAddress}\n` : ""}${arrivalSectionText(p.arrivalInstructions)}
${p.treatmentTimeLine ? `\n${p.treatmentTimeLine}\n` : ""}
${intake && p.intakeUrl ? `\n${intake.heading}\n\n${intake.body}\n\n${INTAKE_CTA_LABEL}: ${p.intakeUrl}\n\n${INTAKE_IGNORE_LINE}\n` : ""}
${p.preCareInstructions ? `\nBefore your appointment:\n${p.preCareInstructions}\n` : ""}
${p.rescheduleUrl ? `Reschedule: ${p.rescheduleUrl}\n` : ""}
Cancel: ${p.cancellationUrl}
Booking reference: ${p.bookingReference.trim()}
${p.portalLoginUrl ? `\nView your forms, appointments, and care instructions in your secure client portal:\n${p.portalLoginUrl}\n` : ""}`;
}

// The intake section renders only when the cron actually minted a link for
// this send. `intakeUrl` non-null IS the decision - the template never
// re-derives eligibility, so there is exactly one place that decides.
function intakeSectionFor(
  kind: IntakeReminderKind,
  p: ReminderProps,
): IntakeSectionCopy | null {
  return p.intakeUrl ? INTAKE_SECTION_COPY[kind] : null;
}

export function build24hReminderEmail(p: ReminderProps): {
  subject: string;
  html: string;
  text: string;
} {
  // SUBJECT RULE (HIPAA-READY-01, #828): the subject used to carry the
  // service and start time (PR #157). A subject persists in the inbox, shows
  // on a lock screen and is stored by the email provider, so the time now
  // lives in the headline and body only (12h, as PR #157 chose).
  const subject = withReference(`Appointment reminder from ${p.studioName}`, p.bookingReference);
  // The headline names no day: "tomorrow" is a relative date (PREVIEW RULE).
  const headline = "Your appointment is coming up.";
  const lead = "Your appointment is tomorrow.";
  const intake = intakeSectionFor("24h", p);
  return {
    subject,
    html: withPreheader(reminderHtml({ headline, lead, subject, p, intake }), clientPreheader(p.studioName)),
    text: withTextPreheader(reminderText({ headline, lead, p, intake }), clientPreheader(p.studioName)),
  };
}

export function build2hReminderEmail(p: ReminderProps): {
  subject: string;
  html: string;
  text: string;
} {
  // SUBJECT RULE (#828): same as the 24h reminder, and DISTINCT from it (Codex
  // P1 4354990818): identical subjects thread the 2-hour reminder under the
  // 24-hour one. "see you soon" names the window without a date or time.
  const subject = withReference(`Appointment reminder from ${p.studioName}: see you soon`, p.bookingReference);
  const headline = "See you soon.";
  const lead = "Your appointment is in about 2 hours.";
  const intake = intakeSectionFor("2h", p);
  return {
    subject,
    html: withPreheader(reminderHtml({ headline, lead, subject, p, intake }), clientPreheader(p.studioName)),
    text: withTextPreheader(reminderText({ headline, lead, p, intake }), clientPreheader(p.studioName)),
  };
}

type NoShowFollowupProps = {
  clientName: string;
  studioName: string;
  rebookUrl: string | null;
  // Per-booking label: two missed bookings must not share one thread.
  bookingReference: string;
};

export function buildNoShowFollowupEmail(p: NoShowFollowupProps): {
  subject: string;
  html: string;
  text: string;
} {
  // SUBJECT RULE (HIPAA-READY-01, #828): no date, relative date or attendance
  // fact in a subject (Codex P1 on #859), and the PREVIEW RULE keeps it out of
  // the body's opening too. The body still says the client was not seen.
  const subject = withReference(`A message from ${p.studioName}`, p.bookingReference);
  const safeStudio = escapeHtml(p.studioName);
  const lead = `This is a note from ${p.studioName} about your recent appointment.`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          We hope you&rsquo;re well.
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          ${escapeHtml(lead)}
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
        <tr><td style="padding-bottom:16px; font-family:-apple-system, system-ui, sans-serif; font-size:12px; color:#6B6B6B;">
          Booking reference: ${escapeHtml(p.bookingReference.trim())}
        </td></tr>
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          ${safeStudio} via Hone
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `We hope you're well.

${lead}

We didn't see you at your appointment today. We hope everything is okay.
${p.rebookUrl ? `\nIf you'd like to rebook: ${p.rebookUrl}\n` : ""}
Booking reference: ${p.bookingReference.trim()}
${p.studioName} via Hone
`;

  return {
    subject,
    html: withPreheader(html, clientPreheader(p.studioName)),
    text: withTextPreheader(text, clientPreheader(p.studioName)),
  };
}

// PR #306: automated intake-form REMINDER email, sent by the appointment-
// reminder cron ~7 days and ~3 days before a confirmed appointment when the
// client's latest intake is still in_progress. Distinct from the practitioner-
// triggered buildIntakeRequestEmail ("please complete your UPDATED intake") —
// this is a gentle pre-appointment nudge.
//
// Copy rules: short + friendly; mention the appointment date/time; say the form
// helps the practitioner prepare safely; carry a fresh secure link; tell the
// client they can ignore it if already completed. No medical claims, no
// delivery/receipt overclaim, no sensitive detail in the subject.

import { localTimeString12h } from "@/lib/booking/tz";

export type IntakeReminderEmail = {
  subject: string;
  html: string;
  text: string;
};

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

export function buildIntakeReminderEmail(p: {
  studioName: string;
  intakeUrl: string;
  startsAt: Date;
  timezone: string;
}): IntakeReminderEmail {
  const studioName = p.studioName.trim() || "Your studio";
  // No PII / no date in the subject (privacy) — generic, non-alarming.
  const subject =
    "Reminder: please complete your intake form before your appointment";

  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = localTimeString12h(p.startsAt, p.timezone);
  const whenLine = `Your appointment with ${studioName} is on ${dayStr} at ${timeStr}.`;

  const text = [
    whenLine,
    "",
    "Completing your intake form beforehand helps your practitioner prepare safely for your visit.",
    "",
    "Please complete it using the secure link below:",
    p.intakeUrl,
    "",
    "If you've already completed it, you can ignore this message.",
  ].join("\n");

  const html = `
<!DOCTYPE html>
<html>
  <body style="margin:0; padding:0; background:#FAFAFA; font-family:-apple-system, system-ui, sans-serif; color:#0A0A0A;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="background:#FFFFFF; border:1px solid #E8E8E8; border-radius:12px;">
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6;">
                  ${escapeHtml(whenLine)}
                </p>
                <p style="margin:0 0 24px 0; font-size:15px; line-height:1.6; color:#3F3F3F;">
                  Completing your intake form beforehand helps your practitioner prepare safely for your visit.
                </p>
                <p style="margin:0 0 24px 0;">
                  <a href="${p.intakeUrl}" style="display:inline-block; padding:12px 20px; background:#0A0A0A; color:#FFFFFF; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px;">
                    Complete intake form
                  </a>
                </p>
                <p style="margin:0 0 20px 0; font-size:13px; line-height:1.6; color:#6B6B6B;">
                  If the button does not work, copy and paste this link into your browser:<br />
                  <span style="word-break:break-all;">${escapeHtml(p.intakeUrl)}</span>
                </p>
                <p style="margin:0; font-size:13px; line-height:1.6; color:#6B6B6B;">
                  If you've already completed it, you can ignore this message.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

  return { subject, html, text };
}

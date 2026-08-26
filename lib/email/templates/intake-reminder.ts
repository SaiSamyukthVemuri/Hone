// Intake-form reminder copy, in both the shapes the reminder cron can send it.
//
// SINGLE SOURCE OF THE INTAKE COPY. The same heading/body/CTA appears in two
// places and must never drift between them:
//
//   * COMPOSED — the ~24h / ~2h appointment reminder carries an intake section
//     when the client's latest intake is still in_progress. That section is
//     rendered by lib/email/templates/reminders.ts, which imports the
//     constants below rather than restating them.
//   * STANDALONE — when the studio has turned the matching appointment
//     reminder OFF but left intake reminders ON, the same window sends the
//     intake nudge on its own. buildIntakeReminderEmail below is that email.
//
// Exactly one of the two is ever sent for a given appointment and window; the
// cron claims the single reminder_24h / reminder_2h slot either way.
//
// SUBJECT RULE. Completion state never appears in a subject line. A subject
// persists in the inbox and shows on a lock screen, and it is asserted at send
// time — so "your intake form is still incomplete" would both broadcast a
// clinical-adjacent fact and become false the moment the client submits during
// the send race or delivery is delayed. The standalone subjects below are
// neutral, carry no PII, no date and no studio name, and stay true either way.
//
// Copy rules: no medical claim, no delivery/receipt overclaim, no shaming, no
// intake answers, a fresh secure link, and an explicit "ignore if already done"
// escape hatch so the message is honest under both races.

import { localTimeString12h } from "@/lib/booking/tz";

export type IntakeReminderKind = "24h" | "2h";

export type IntakeSectionCopy = {
  heading: string;
  body: string;
};

/** Heading + body for the intake section, per reminder window. */
export const INTAKE_SECTION_COPY: Readonly<
  Record<IntakeReminderKind, IntakeSectionCopy>
> = {
  "24h": {
    heading: "Please complete your intake form",
    body: "We still need your intake form before your appointment. Completing it ahead of time helps your practitioner prepare.",
  },
  "2h": {
    heading: "Quick reminder about your intake form",
    body: "If you haven't already, please complete your intake form before your appointment.",
  },
};

/** The one CTA label, shared by the composed section and the standalone email. */
export const INTAKE_CTA_LABEL = "Complete intake form";

/** Subject for the STANDALONE intake email only. Never exposes completion state. */
export const INTAKE_STANDALONE_SUBJECT: Readonly<
  Record<IntakeReminderKind, string>
> = {
  "24h": "Please complete your intake form",
  "2h": "A quick reminder about your intake form",
};

/**
 * Kept truthful under two races we cannot close: the client may submit while
 * the provider call is in flight, and delivery may be delayed.
 */
export const INTAKE_IGNORE_LINE =
  "If you've already completed it, you can ignore this message.";

export const INTAKE_LINK_FALLBACK_LINE =
  "If the button does not work, copy and paste this link into your browser:";

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
  kind: IntakeReminderKind;
  studioName: string;
  intakeUrl: string;
  startsAt: Date;
  timezone: string;
}): IntakeReminderEmail {
  const studioName = p.studioName.trim() || "Your studio";
  const subject = INTAKE_STANDALONE_SUBJECT[p.kind];
  const { heading, body } = INTAKE_SECTION_COPY[p.kind];

  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = localTimeString12h(p.startsAt, p.timezone);
  const whenLine = `Your appointment with ${studioName} is on ${dayStr} at ${timeStr}.`;

  const text = [
    heading,
    "",
    whenLine,
    "",
    body,
    "",
    `${INTAKE_CTA_LABEL}: ${p.intakeUrl}`,
    "",
    INTAKE_IGNORE_LINE,
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
                <p style="margin:0 0 16px 0; font-size:16px; font-weight:600; line-height:1.5;">
                  ${escapeHtml(heading)}
                </p>
                <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6;">
                  ${escapeHtml(whenLine)}
                </p>
                <p style="margin:0 0 24px 0; font-size:15px; line-height:1.6; color:#3F3F3F;">
                  ${escapeHtml(body)}
                </p>
                <p style="margin:0 0 24px 0;">
                  <a href="${p.intakeUrl}" style="display:inline-block; padding:12px 20px; background:#0A0A0A; color:#FFFFFF; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px;">
                    ${escapeHtml(INTAKE_CTA_LABEL)}
                  </a>
                </p>
                <p style="margin:0 0 20px 0; font-size:13px; line-height:1.6; color:#6B6B6B;">
                  ${escapeHtml(INTAKE_LINK_FALLBACK_LINE)}<br />
                  <span style="word-break:break-all;">${escapeHtml(p.intakeUrl)}</span>
                </p>
                <p style="margin:0; font-size:13px; line-height:1.6; color:#6B6B6B;">
                  ${escapeHtml(INTAKE_IGNORE_LINE)}
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

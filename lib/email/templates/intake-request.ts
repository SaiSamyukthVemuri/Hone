import { clientPreheader, withPreheader, withTextPreheader } from "@/lib/email/preheader";
import { withReference } from "@/lib/email/subject-reference";
// Practitioner-triggered intake reissue email (PR: intake reissue +
// history). Sent when the practitioner clicks "Request intake update"
// from the client profile. Distinct from the booking-confirmation
// intake link block, which is appended to the booking confirmation
// itself and is not a standalone email.
//
// Copy is deliberately neutral. No mention of internal testing, no
// mention of deletion, no overclaiming. The practitioner can give the
// client a reason in person if relevant.

export type IntakeRequestEmail = {
  subject: string;
  html: string;
  text: string;
};

export function buildIntakeRequestEmail(p: {
  studioName: string;
  intakeUrl: string;
  // Per-intake-form label (emailIntakeReference): each reissue creates a new
  // intake row, so two requests must not thread together
  // (tests/lib/email/email-subject-sweep.test.ts).
  intakeReference: string;
}): IntakeRequestEmail {
  const studioName = p.studioName.trim() || "Your studio";
  const subject = withReference("Please complete your updated intake form", p.intakeReference);
  // PREVIEW RULE (HIPAA-READY-01, #828): this sentence opens the body, so a
  // client that strips the preheader filler previews it. "visit", not
  // "treatment": the opening states no treatment fact.

  const text = [
    `${studioName} is asking you to complete an updated intake form before your appointment or next visit.`,
    "",
    "Please complete it using the secure link below:",
    p.intakeUrl,
    "",
    "If you have any questions, reply to this email.",
    "",
    `Intake reference: ${p.intakeReference.trim()}`,
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
                  ${escapeHtml(studioName)} is asking you to complete an updated intake form before your appointment or next visit.
                </p>
                <p style="margin:0 0 24px 0; font-size:15px; line-height:1.6; color:#3F3F3F;">
                  Please complete it using the secure link below.
                </p>
                <p style="margin:0 0 24px 0;">
                  <a href="${p.intakeUrl}" style="display:inline-block; padding:12px 20px; background:#0A0A0A; color:#FFFFFF; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px;">
                    Open intake form
                  </a>
                </p>
                <p style="margin:0; font-size:13px; line-height:1.6; color:#6B6B6B;">
                  If the button does not work, copy and paste this link into your browser:<br />
                  <span style="word-break:break-all;">${escapeHtml(p.intakeUrl)}</span>
                </p>
                <p style="margin:16px 0 0 0; font-size:12px; line-height:1.6; color:#6B6B6B;">
                  Intake reference: ${escapeHtml(p.intakeReference.trim())}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

  return { subject, html: withPreheader(html, clientPreheader(null)), text: withTextPreheader(text, clientPreheader(null)) };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

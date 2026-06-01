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
}): IntakeRequestEmail {
  const studioName = p.studioName.trim() || "Your studio";
  const subject = "Please complete your updated intake form";

  const text = [
    `${studioName} is asking you to complete an updated intake form before your appointment or next treatment.`,
    "",
    "Please complete it using the secure link below:",
    p.intakeUrl,
    "",
    "If you have any questions, reply to this email.",
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
                  ${escapeHtml(studioName)} is asking you to complete an updated intake form before your appointment or next treatment.
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Plain-HTML invitation template. Matches the magic-link email style: warm
// off-white background, Georgia serif headline, sharp-cornered black CTA.

const SIGN_IN_URL = "https://hone.care/login";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type InvitationEmail = {
  subject: string;
  html: string;
  text: string;
};

export function buildInvitationEmail(params: {
  inviteeEmail: string;
  inviteeDisplayName: string | null;
  studioName: string;
  inviterName: string;
}): InvitationEmail {
  const { inviteeEmail, inviteeDisplayName, studioName, inviterName } = params;
  const greetingName = inviteeDisplayName?.trim() || inviteeEmail;

  const subject = `You've been invited to ${studioName} on Hone`;

  const safeGreeting = escapeHtml(greetingName);
  const safeInviter = escapeHtml(inviterName);
  const safeStudio = escapeHtml(studioName);
  const safeEmail = escapeHtml(inviteeEmail);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#FAFAF7; color:#0A0A0A;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAFAF7; padding:40px 20px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
            <tr>
              <td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em; color:#0A0A0A;">
                Hone
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15; color:#0A0A0A;">
                You've been invited to ${safeStudio}.
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6; color:#0A0A0A;">
                ${safeGreeting},
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6; color:#0A0A0A;">
                ${safeInviter} invited you to join ${safeStudio} on Hone, the charting tool for electrolysis and laser practitioners.
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:32px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6; color:#0A0A0A;">
                To join the team, sign in at hone.care using <strong>${safeEmail}</strong>. You'll be added to ${safeStudio} automatically.
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:40px;">
                <a href="${SIGN_IN_URL}" style="display:inline-block; padding:14px 28px; background-color:#0A0A0A; color:#FAFAF7; font-family:-apple-system, system-ui, sans-serif; font-size:13px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase; text-decoration:none;">
                  Sign in to Hone
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px; border-top:1px solid #E5E2DA;"></td>
            </tr>
            <tr>
              <td style="font-family:-apple-system, system-ui, sans-serif; font-size:11px; line-height:1.6; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
                Hone &middot; Charting software for electrolysis and laser practitioners
              </td>
            </tr>
            <tr>
              <td style="padding-top:8px; font-family:-apple-system, system-ui, sans-serif; font-size:11px; line-height:1.6; color:#6B6B6B;">
                hone.care
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `${greetingName},

${inviterName} invited you to join ${studioName} on Hone, the charting tool for electrolysis and laser practitioners.

To join the team, sign in at hone.care using ${inviteeEmail}. You'll be added to ${studioName} automatically.

Sign in: ${SIGN_IN_URL}

Hone. Charting software for electrolysis and laser practitioners.
hone.care
`;

  return { subject, html, text };
}

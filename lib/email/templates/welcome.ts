// Studio-owner invitation email. ONE truthful message for BOTH a brand-new and
// an existing Hone account: at studio-creation time the owner has been INVITED,
// not yet added — membership + the authoritative acceptance happen when they
// sign in and confirm the current policies. So we never infer account existence
// and never claim "has been added". Matches the transactional style of
// invitation.ts (warm off-white, Georgia serif headline, sharp black CTA).

const SIGN_IN_URL = "https://hone.care/login";
const SUPPORT_EMAIL = "hello@hone.care";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type WelcomeEmail = {
  subject: string;
  html: string;
  text: string;
};

export type WelcomeEmailParams = {
  ownerDisplayName: string | null;
  ownerEmail: string;
  studioName: string;
  // Public booking URL (https://hone.care/book/<slug>). May be "".
  bookingUrl: string;
};

export function buildWelcomeEmail(params: WelcomeEmailParams): WelcomeEmail {
  const greetingName = params.ownerDisplayName?.trim() || params.ownerEmail;

  const subject = `You've been invited to ${params.studioName} on Hone`;
  const headline = `You've been invited to ${params.studioName}.`;
  const lede = `${greetingName}, you've been invited to join ${params.studioName} on Hone. Sign in to join — if you already have a Hone account, use it. You'll confirm the current Terms of Service and Privacy Policy when you join, and then a short guided setup helps you get the studio ready for its first booking.`;
  const helper = "Sign in with this email address to join your studio.";

  const safeHeadline = escapeHtml(headline);
  const safeLede = escapeHtml(lede);
  const safeHelper = escapeHtml(helper);
  const hasBookingUrl = params.bookingUrl.trim().length > 0;
  const safeBookingUrl = escapeHtml(params.bookingUrl);

  const bookingRowHtml = hasBookingUrl
    ? `<tr>
              <td style="padding-bottom:32px; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; color:#6B6B6B;">
                Your booking page (live once setup is done): <a href="${safeBookingUrl}" style="color:#0A0A0A;">${safeBookingUrl}</a>
              </td>
            </tr>`
    : "";

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
                ${safeHeadline}
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6; color:#0A0A0A;">
                ${safeLede}
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:32px;">
                <a href="${SIGN_IN_URL}" style="display:inline-block; padding:14px 28px; background-color:#0A0A0A; color:#FAFAF7; font-family:-apple-system, system-ui, sans-serif; font-size:13px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase; text-decoration:none;">
                  Sign in to Hone
                </a>
              </td>
            </tr>
            ${bookingRowHtml}
            <tr>
              <td style="padding-bottom:32px; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; color:#6B6B6B;">
                ${safeHelper}
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px; border-top:1px solid #E5E2DA;"></td>
            </tr>
            <tr>
              <td style="font-family:-apple-system, system-ui, sans-serif; font-size:12px; line-height:1.6; color:#6B6B6B;">
                Questions? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:#6B6B6B;">${SUPPORT_EMAIL}</a>.
              </td>
            </tr>
            <tr>
              <td style="padding-top:8px; font-family:-apple-system, system-ui, sans-serif; font-size:11px; line-height:1.6; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
                Hone &middot; Charting software for electrolysis and laser practitioners
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const bookingLineText = hasBookingUrl
    ? `\nYour booking page (live once setup is done): ${params.bookingUrl}\n`
    : "";

  const text = `${headline}

${lede}

Sign in: ${SIGN_IN_URL}
${bookingLineText}
${helper}

Questions? Email ${SUPPORT_EMAIL}.

Hone. Charting software for electrolysis and laser practitioners.
hone.care
`;

  return { subject, html, text };
}

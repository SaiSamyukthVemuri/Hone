// Studio-owner welcome email. Two variants, matching the transactional style of
// invitation.ts (warm off-white background, Georgia serif headline, sharp black
// CTA). Onboarding, not marketing — no sales language, no overclaims.
//
//   * new_owner        — a brand-new owner (no existing Hone account). "Your
//                        studio is ready", we'll guide you through setup.
//   * existing_account — the owner's email already belongs to a Hone account.
//                        Do NOT re-invite; tell them to sign in with the account
//                        they already have.

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
  variant: "new_owner" | "existing_account";
  ownerDisplayName: string | null;
  ownerEmail: string;
  studioName: string;
  // Public booking URL (https://hone.care/book/<slug>). May be "" if a slug is
  // somehow absent; the line is omitted when empty.
  bookingUrl: string;
};

type Copy = {
  subject: string;
  headline: string;
  lede: string;
  cta: string;
  helper: string;
};

function copyFor(params: WelcomeEmailParams, greetingName: string): Copy {
  if (params.variant === "existing_account") {
    return {
      subject: `You've been added to ${params.studioName} on Hone`,
      headline: `You've been added to ${params.studioName}.`,
      // Do NOT claim access is already complete: an existing account may still
      // need to review the current policies before entering the new studio.
      lede: `${greetingName}, your Hone account (${params.ownerEmail}) has been added to ${params.studioName}. Sign in with the account you already have — you may be asked to review the current Terms of Service and Privacy Policy before entering the studio.`,
      cta: "Sign in to Hone",
      helper:
        "Once you're in, a short guided setup on your dashboard helps you get the studio ready for bookings.",
    };
  }
  return {
    subject: `Welcome to Hone — ${params.studioName} is ready`,
    headline: `${params.studioName} is ready on Hone.`,
    lede: `${greetingName}, your studio is set up. Sign in to finish the last few steps — we'll guide you through it in about five minutes, and you'll be ready to take your first booking.`,
    cta: "Sign in to Hone",
    helper:
      "Sign in with this email address. Your guided setup opens automatically on your dashboard.",
  };
}

export function buildWelcomeEmail(params: WelcomeEmailParams): WelcomeEmail {
  const greetingName =
    params.ownerDisplayName?.trim() || params.ownerEmail;
  const c = copyFor(params, greetingName);

  const safeHeadline = escapeHtml(c.headline);
  const safeLede = escapeHtml(c.lede);
  const safeHelper = escapeHtml(c.helper);
  const hasBookingUrl = params.bookingUrl.trim().length > 0;
  const safeBookingUrl = escapeHtml(params.bookingUrl);

  const bookingRowHtml = hasBookingUrl
    ? `<tr>
              <td style="padding-bottom:32px; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; color:#6B6B6B;">
                Your booking page: <a href="${safeBookingUrl}" style="color:#0A0A0A;">${safeBookingUrl}</a>
              </td>
            </tr>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(c.subject)}</title>
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
                  ${escapeHtml(c.cta)}
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
    ? `\nYour booking page: ${params.bookingUrl}\n`
    : "";

  const text = `${c.headline}

${c.lede}

Sign in: ${SIGN_IN_URL}
${bookingLineText}
${c.helper}

Questions? Email ${SUPPORT_EMAIL}.

Hone. Charting software for electrolysis and laser practitioners.
hone.care
`;

  return { subject: c.subject, html, text };
}

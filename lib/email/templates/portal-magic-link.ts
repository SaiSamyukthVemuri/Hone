// Client portal magic-link email template.
//
// Builds the {subject, html, text} shape that lib/email/send-appointment.ts
// sendEmailSafely consumes. The email contains:
//   * a one-line greeting that names the studio
//   * the magic link as a primary CTA button + the raw URL underneath
//   * a 1-hour expiry reminder (raised from 30 minutes in PR #166;
//     see the comment block in app/portal/login/actions.ts for the
//     real-world delivery-latency rationale)
//   * a not-you opt-out line
//
// What this email does NOT include:
//   * The client's name. The same email is sent to every active match;
//     each magic link binds to one (studio, client) pair internally,
//     but the email body never names the client so an email forwarded
//     or intercepted leaks no identity.
//   * Appointment details, intake answers, or any clinical data.
//   * The raw session token. Only the magic-link URL appears; the
//     session is established server-side after the visitor clicks
//     through.
//
// Visual style (PR #127). The previous shape was an unstyled <div>
// that looked less legitimate than the rest of the Hone client
// emails. It now uses the same branded table-based shell as the
// booking confirmation, reminder, and cancellation emails:
//   * #FAFAF7 page background, #0A0A0A ink
//   * Georgia-serif "Hone" wordmark at the top
//   * Georgia-serif headline ("Your secure sign-in link.")
//   * system sans-serif body
//   * dark CTA button followed by the raw paste-through link
//   * "<studio> via Hone" uppercase caption footer
// The HTML pattern matches lib/email/templates/reminders.ts so the
// rendered look is uniform across the client email surface.
//
// Subject change (PR #127). Gmail and Outlook thread inbound emails
// when the normalized subject is identical, which buried the newest
// magic-link email under stale links. The subject now reads
//   "Your new secure <Studio> sign-in link"
// which both signals freshness to the client and is different enough
// from the prior phrasing ("Your secure <Studio> portal link") that
// historical threads break cleanly. No sensitive data is added to
// the subject (no client name, no token, no timestamp).

export type PortalMagicLinkEmailInput = {
  studioName: string;
  magicLink: string;
};

export type PortalMagicLinkEmail = {
  subject: string;
  html: string;
  text: string;
};

// PR #166. Copy MUST stay in sync with MAGIC_LINK_TTL_MS in
// app/portal/login/actions.ts. Today: 60 minutes => "1 hour."
// The expiry source of truth is the actions.ts constant; this
// string is purely the human-facing description rendered in the
// email body. A drift between the two is caught by
// tests/lib/email/portal-magic-link.test.ts (which pins this
// string) plus tests/app/portal/login/magic-link-ttl.test.ts
// (which pins the actions.ts constant). Pick a phrase that reads
// naturally if a future TTL goes back to minutes (e.g. "45 minutes")
// or up to hours; the template body interpolates this verbatim.
const TTL_DESCRIPTION = "1 hour";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildPortalMagicLinkEmail(
  input: PortalMagicLinkEmailInput,
): PortalMagicLinkEmail {
  const studio = input.studioName.trim() || "your studio";
  const link = input.magicLink;
  const subject = `Your new secure ${studio} sign-in link`;

  const text =
    `Use this secure link to sign in to your ${studio} client portal:\n\n` +
    `${link}\n\n` +
    `This link expires in ${TTL_DESCRIPTION}. ` +
    `If you did not request this, you can ignore this email.\n\n` +
    `${studio} via Hone\n`;

  const studioH = escapeHtml(studio);
  const linkH = escapeHtml(link);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          Your secure sign-in link.
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          Use the button below to sign in to your <strong>${studioH}</strong> client portal.
        </td></tr>
        <tr><td style="padding:0 0 20px 0;">
          <a href="${linkH}" style="display:inline-block; padding:14px 24px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px; letter-spacing:0.02em;">
            Open my portal
          </a>
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B; word-break:break-all;">
          Or paste this link into your browser:<br/>
          <a href="${linkH}" style="color:#6B6B6B; text-decoration:underline;">${linkH}</a>
        </td></tr>
        <tr><td style="padding:20px 0 24px 0; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          This link expires in ${TTL_DESCRIPTION}. If you did not request this, you can ignore this email.
        </td></tr>
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          ${studioH} via Hone
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

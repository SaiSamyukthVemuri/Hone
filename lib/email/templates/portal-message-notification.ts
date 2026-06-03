// Notification email for a new secure portal message.
//
// The body is INTENTIONALLY a one-line notification + a link to the
// studio-scoped /portal/login surface. The message subject and body
// are NEVER included here; the spec is explicit that the
// practitioner-authored text lives only inside the portal so a
// forwarded or intercepted email leaks nothing clinical.
//
// We also deliberately do NOT mint a direct portal verify link.
// Pointing the client at /portal/login forces them through the
// normal magic-link flow, so possession of a forwarded notification
// email is not enough to read messages.
//
// Visual style (PR #127). Matches the branded table-based shell used
// by the booking confirmation, reminder, and magic-link emails:
//   * #FAFAF7 page background, #0A0A0A ink
//   * Georgia-serif "Hone" wordmark at the top
//   * Georgia-serif headline ("You have a new secure message.")
//   * system sans-serif body
//   * dark CTA button to /portal/login (paste-through link below)
//   * "<studio> via Hone" uppercase caption footer
// The text fallback is similarly restructured so plain-text readers
// see the same headline + lead + CTA shape.
//
// What is NOT in this email (still):
//   * The portal message subject. Carried by the row in the DB; never
//     surfaced in email.
//   * The portal message body. Same: portal-only.
//   * The client's name. The notification is generic enough that a
//     forwarded copy reveals only that "<Studio>" left a message and
//     points at the public login page.
//   * Appointment details, intake answers, treatment-plan notes,
//     any other clinical or administrative data.

export type PortalMessageNotificationEmailInput = {
  studioName: string;
  portalLoginUrl: string;
};

export type PortalMessageNotificationEmail = {
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

export function buildPortalMessageNotificationEmail(
  input: PortalMessageNotificationEmailInput,
): PortalMessageNotificationEmail {
  const studio = input.studioName.trim() || "your studio";
  const link = input.portalLoginUrl;
  const subject = `New secure message from ${studio}`;

  const text =
    `${studio} left you a secure message in your client portal.\n\n` +
    `Open your portal to review it:\n` +
    `${link}\n\n` +
    `For your privacy, the message is only shown inside the portal.\n\n` +
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
          You have a new secure message.
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          <strong>${studioH}</strong> left you a secure message in your client portal.
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
          For your privacy, the message itself is only shown inside the portal.
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

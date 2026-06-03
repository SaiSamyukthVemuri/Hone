// Notification email to the studio side when a client posts a reply
// to a secure portal message.
//
// The body is INTENTIONALLY a one-line notification + a link to the
// practitioner's client profile. The reply subject (there is no
// subject; replies hang off a parent message) and body are NEVER
// included here; the spec is explicit that the client-authored text
// lives only inside Hone so a forwarded or intercepted email leaks
// nothing clinical.
//
// We also deliberately do NOT include client name, parent message
// subject/body, treatment plan details, appointment details, or
// anything else from the row. The link drops the practitioner into
// the existing client profile surface (already auth-gated) where the
// reply is rendered under its parent message.
//
// Visual style. Matches the branded table-based shell used by every
// other Hone email (booking confirmation, reminders, portal magic-
// link, portal message notification) so the studio-facing inbox
// stays visually uniform.

export type PortalReplyNotificationEmailInput = {
  studioName: string;
  clientProfileUrl: string;
};

export type PortalReplyNotificationEmail = {
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

export function buildPortalReplyNotificationEmail(
  input: PortalReplyNotificationEmailInput,
): PortalReplyNotificationEmail {
  const studio = input.studioName.trim() || "your studio";
  const link = input.clientProfileUrl;
  const subject = "New client reply in Hone";

  const text =
    `A client replied to a secure portal message in Hone.\n\n` +
    `Open the client profile to review it:\n` +
    `${link}\n\n` +
    `For privacy, the reply is only shown inside Hone.\n\n` +
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
          A client replied in Hone.
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          A client replied to a secure portal message. Open the client profile to review it.
        </td></tr>
        <tr><td style="padding:0 0 20px 0;">
          <a href="${linkH}" style="display:inline-block; padding:14px 24px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px; letter-spacing:0.02em;">
            Open client profile
          </a>
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B; word-break:break-all;">
          Or paste this link into your browser:<br/>
          <a href="${linkH}" style="color:#6B6B6B; text-decoration:underline;">${linkH}</a>
        </td></tr>
        <tr><td style="padding:20px 0 24px 0; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          For privacy, the reply itself is only shown inside Hone.
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

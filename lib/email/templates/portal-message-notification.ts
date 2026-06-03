// Notification email for a new secure portal message.
//
// The body is INTENTIONALLY a one-line notification + a link to
// /portal/login. The message subject and body are NEVER included
// here; the spec is explicit that the practitioner-authored text
// lives only inside the portal so a forwarded or intercepted email
// leaks nothing clinical.
//
// We also deliberately do NOT mint a direct portal verify link.
// Pointing the client at /portal/login forces them through the
// normal magic-link flow, so possession of a forwarded notification
// email is not enough to read messages.

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
    `For your privacy, the message is only shown inside the portal.\n`;

  const studioH = escapeHtml(studio);
  const linkH = escapeHtml(link);
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A;font-size:16px;line-height:1.6">` +
    `<p>${studioH} left you a secure message in your client portal.</p>` +
    `<p><a href="${linkH}">${linkH}</a></p>` +
    `<p style="color:#6B6B6B;font-size:14px">For your privacy, the message is only shown inside the portal.</p>` +
    `</div>`;

  return { subject, html, text };
}

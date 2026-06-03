// Client portal magic-link email template.
//
// Builds the {subject, html, text} shape that lib/email/send-appointment.ts
// sendEmailSafely consumes. The email contains:
//   * a one-line greeting that names the studio
//   * the magic link
//   * a 30-minute expiry reminder
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

export type PortalMagicLinkEmailInput = {
  studioName: string;
  magicLink: string;
};

export type PortalMagicLinkEmail = {
  subject: string;
  html: string;
  text: string;
};

const TTL_DESCRIPTION = "30 minutes";

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
  const subject = `Your secure ${studio} portal link`;

  const text =
    `Use this secure link to access your ${studio} portal:\n\n` +
    `${link}\n\n` +
    `This link expires in ${TTL_DESCRIPTION}. ` +
    `If you did not request this, you can ignore this email.\n`;

  const studioH = escapeHtml(studio);
  const linkH = escapeHtml(link);
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A;font-size:16px;line-height:1.6">` +
    `<p>Use this secure link to access your ${studioH} portal:</p>` +
    `<p><a href="${linkH}">${linkH}</a></p>` +
    `<p style="color:#6B6B6B;font-size:14px">This link expires in ${TTL_DESCRIPTION}. If you did not request this, you can ignore this email.</p>` +
    `</div>`;

  return { subject, html, text };
}

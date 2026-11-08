// The owner email on a waitlist decline (HON-7 item 4). Wording is Sam's, verbatim.
//
// WHAT THIS EMAIL DELIBERATELY OMITS: the invitee's name, contact details, answers, the studio's client list, the time that was
// offered, and any count. It names nothing about the person, because a mailbox preview, a forwarded message and the provider's
// own records all outlive the page the owner signs in to. The link carries no identifier either: the owner lands on the follow-up
// section and sees the response after signing in.
//
// The payload is a PURE FUNCTION of the app origin. Two attempts for one outbox row must render identical bytes, because the
// provider idempotency key depends on the row and the provider answers a changed body under one key with an error, not a replay.

export const WAITLIST_DECLINE_OWNER_SUBJECT = "A waitlist response needs your attention";
export const WAITLIST_DECLINE_OWNER_BODY =
  "Someone responded to your consultation invitation. Sign in to review their response and follow up.";
export const WAITLIST_DECLINE_OWNER_BUTTON = "Review response";
export const WAITLIST_DECLINE_OWNER_PATH = "/settings/waitlist?followup=1";

export function buildWaitlistDeclineOwnerEmail(input: { appOrigin: string }): { subject: string; html: string; text: string } {
  const url = `${input.appOrigin.replace(/\/+$/, "")}${WAITLIST_DECLINE_OWNER_PATH}`;
  const text = `${WAITLIST_DECLINE_OWNER_BODY}\n\n${WAITLIST_DECLINE_OWNER_BUTTON}: ${url}\n\nHone\n`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${WAITLIST_DECLINE_OWNER_SUBJECT}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">${WAITLIST_DECLINE_OWNER_BODY}</td></tr>
        <tr><td style="padding-bottom:24px;"><a href="${url}" style="display:inline-block; padding:12px 22px; background:#0A0A0A; color:#FAFAF7; border-radius:6px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; text-decoration:none;">${WAITLIST_DECLINE_OWNER_BUTTON}</a></td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject: WAITLIST_DECLINE_OWNER_SUBJECT, html, text };
}

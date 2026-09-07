// New-client waitlist INVITATION email (WAIT DELIVERY-01).
//
// Builds the {subject, html, text} shape the existing send paths consume, in
// the same branded shell as lib/email/templates/portal-magic-link.ts and
// reminders.ts, so the client email surface stays uniform.
//
// ===========================================================================
// THE ONE THING THIS EMAIL CARRIES, AND WHAT IT IS NOT
// ===========================================================================
//
// The invitation link is a BEARER CREDENTIAL that RESOLVES an invitation. It
// is not authority to mutate one. Whoever holds the URL can see that a spot is
// being offered and by which studio; they cannot redeem or decline it, because
// every mutation additionally requires the short-lived recipient proof that is
// delivered separately to the address stored on the waitlist entry.
//
// That split is the whole design, and it is why this template deliberately
// carries NO code, NO one-tap "accept" and NO mutating URL. An email that
// contained both factors would collapse them back into one, and a forwarded
// message would carry the entire authority with it.
//
// ===========================================================================
// WHAT THIS EMAIL DELIBERATELY OMITS
// ===========================================================================
//
//   * THE RECIPIENT'S NAME. Same reasoning as the portal magic link: an email
//     that is forwarded, quoted or intercepted should leak no identity. The
//     waitlist entry holds `name`, so naming them would be easy and is
//     deliberately declined. The studio is named because the recipient must be
//     able to tell whose offer this is.
//   * THE RECIPIENT'S POSITION IN THE QUEUE. 0185 refuses to store a position
//     or a cached rank at all; inventing one for email copy would manufacture
//     a fact the database declines to keep.
//   * ANY CLINICAL CONTENT. A waitlist prospect is not a client (0185), so
//     there is nothing clinical to include and no client record to reference.
//   * A RELATIVE EXPIRY. The email states an absolute instant, because a
//     duration is only true at one moment and a delayed send makes it false.
//   * THE EXPIRY AS A HARD-CODED STRING. The invitation TTL is owned by
//     `issue_new_client_waitlist_invitation` (0189: `p_ttl_hours`, default 72,
//     clamped 1..168) and stored on `new_client_waitlist_invitations.expires_at`
//     by a server-owned trigger. The caller passes the phrase derived from that
//     stored value; this module never guesses it. Pinning a TTL constant here
//     would create a second owner for a value the database already owns.
//
// Pure module: no I/O, no env reads, no server-only import, no provider.

export type WaitlistInvitationEmailInput = {
  /** Studio display name. Rendered as text only; never used to build a header. */
  studioName: string;
  /**
   * Absolute invitation URL. RESOLVES the invitation; must not mutate it.
   * Rendered as a link and as paste-through text.
   */
  invitationUrl: string;
  /**
   * The expiry as an ABSOLUTE moment, already formatted in the studio's
   * timezone by the caller — e.g. "Thursday, September 10, 2026 at 1:00 PM EDT".
   *
   * NOT a duration. A duration is measured from an origin the email cannot
   * state: "expires in 3 days" is false the moment delivery is delayed, and a
   * remaining-time duration drifts between retries and moves the idempotency
   * key with it. An absolute instant is stable AND stays true however late the
   * message arrives.
   */
  expiresAtLabel: string;
};

export type WaitlistInvitationEmail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * Subject.
 *
 * NO "[HONE WAITLIST]" PREFIX. That marker exists for the STUDIO-facing
 * notification in lib/email/templates/new-client-waitlist.ts, where operators
 * build inbox rules on it. It is operational vocabulary and does not belong in
 * a prospect's inbox.
 *
 * Carries no code, no token, no name and no timestamp — matching the rule the
 * magic-link template states for its own subject.
 */
export function waitlistInvitationSubject(studio: string): string {
  return `Your invitation to book · ${studio}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildWaitlistInvitationEmail(
  input: WaitlistInvitationEmailInput,
): WaitlistInvitationEmail {
  // Same fallback shape the magic-link template uses, so a studio whose name
  // is blank renders naturally rather than leaving a gap in the sentence.
  const studio = input.studioName.trim() || "your studio";
  const url = input.invitationUrl;
  const ttl = input.expiresAtLabel.trim() || "the time stated by the studio";
  const subject = waitlistInvitationSubject(studio);

  const text =
    `A consultation opening is available at ${studio}, and you can choose a time.\n\n` +
    `${url}\n\n` +
    `This invitation expires ${ttl}.\n\n` +
    `For your security, opening the link is not enough on its own: when you ` +
    `choose to book or decline, ${studio} will email a short confirmation code ` +
    `to this address to confirm it is really you.\n\n` +
    `If you no longer want to hear about openings, reply to this email and ` +
    `${studio} will take you off the list.\n\n` +
    `${studio} via Hone\n`;

  const studioH = escapeHtml(studio);
  const urlH = escapeHtml(url);
  const ttlH = escapeHtml(ttl);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          A spot is available.
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          A consultation opening is available at <strong>${studioH}</strong>, and you can choose a time that suits you.
        </td></tr>
        <tr><td style="padding:0 0 20px 0;">
          <a href="${urlH}" style="display:inline-block; padding:14px 24px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px; letter-spacing:0.02em;">
            See the opening
          </a>
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B; word-break:break-all;">
          Or paste this link into your browser:<br/>
          <a href="${urlH}" style="color:#6B6B6B; text-decoration:underline;">${urlH}</a>
        </td></tr>
        <tr><td style="padding:20px 0 0 0; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          This invitation expires ${ttlH}.
        </td></tr>
        <tr><td style="padding:12px 0 24px 0; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          For your security, opening the link is not enough on its own. When you choose to book or decline, ${studioH} will email a short confirmation code to this address so we know it is really you.
        </td></tr>
        <tr><td style="padding:0 0 24px 0; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          If you no longer want to hear about openings, reply to this email and ${studioH} will take you off the list.
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

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
// V1: A HONE PLATFORM IDENTITY, NOT A STUDIO-BRANDED ONE
// ===========================================================================
//
// This email carries NO studio name, NO studio Reply-To and NO studio-derived
// timezone. That is a deliberate launch-scope reduction, and the reason is
// idempotency rather than taste.
//
// The invitation send keys on the invitation alone, with no payload digest,
// because the body carries a bearer token. Losing the digest means the payload
// must be a PURE FUNCTION of the invitation — and every studio field is mutable
// operator state. A renamed studio, a corrected contact address or an adjusted
// timezone all move the rendered bytes while the key stays put, and
// same-key/different-payload is the one case the provider answers with
// `invalid_idempotent_request` rather than a replay. The retry that still
// needed delivering then fails outright. Freezing the timezone alone was not
// enough: the name and the Reply-To are exactly as mutable.
//
// So V1 sends as Hone. The prospect learns whose offer it is when they open the
// link — the secure invitation page can show current studio identity freely,
// because a page is rendered fresh on every visit and has no idempotency key to
// contradict. Studio branding on the email needs the delivery snapshot this
// lane deliberately does not build.
//
// ===========================================================================
// WHAT THIS EMAIL DELIBERATELY OMITS
// ===========================================================================
//
//   * THE RECIPIENT'S NAME. Same reasoning as the portal magic link: an email
//     that is forwarded, quoted or intercepted should leak no identity. The
//     waitlist entry holds `name`, so naming them would be easy and is
//     deliberately declined.
//   * THE STUDIO'S NAME. See the V1 note above — it is mutable, and the payload
//     must not be.
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
  /**
   * Absolute invitation URL. RESOLVES the invitation; must not mutate it.
   * Rendered as a link and as paste-through text.
   */
  invitationUrl: string;
  /**
   * The expiry as an ABSOLUTE moment, already formatted by the caller in a
   * FIXED zone — e.g. "Thursday, September 10, 2026 at 5:00 PM UTC".
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
 * Subject. A CONSTANT.
 *
 * No studio name, so it cannot move when a studio is renamed. No
 * "[HONE WAITLIST]" prefix either — that marker exists for the STUDIO-facing
 * notification in templates/new-client-waitlist.ts, where operators build inbox
 * rules on it, and it is operational vocabulary that does not belong in a
 * prospect's inbox.
 *
 * Carries no code, no token, no name and no timestamp — matching the rule the
 * magic-link template states for its own subject.
 */
export const WAITLIST_INVITATION_SUBJECT = "Your invitation to book";

export function waitlistInvitationSubject(): string {
  return WAITLIST_INVITATION_SUBJECT;
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
  const url = input.invitationUrl;
  const ttl = input.expiresAtLabel.trim() || "the time stated by the studio";
  const subject = waitlistInvitationSubject();

  const text =
    `A consultation opening is available, and you can choose a time.\n\n` +
    `${url}\n\n` +
    `This invitation expires ${ttl}.\n\n` +
    `Opening the link will show you which studio is offering it.\n\n` +
    `For your security, opening the link is not enough on its own: when you ` +
    `choose to book or decline, a short confirmation code is emailed to this ` +
    `address to confirm it is really you.\n\n` +
    `If you no longer want to hear about openings, reply to this email and ask ` +
    `to be taken off the list.\n\n` +
    `Hone\n`;

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
          A consultation opening is available, and you can choose a time that suits you. Opening the link will show you which studio is offering it.
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
          For your security, opening the link is not enough on its own. When you choose to book or decline, a short confirmation code is emailed to this address so we know it is really you.
        </td></tr>
        <tr><td style="padding:0 0 24px 0; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          If you no longer want to hear about openings, reply to this email and ask to be taken off the list.
        </td></tr>
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          Hone
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

// New-client waitlist RECIPIENT PROOF email (WAIT DELIVERY-01).
//
// The second of the two separated authorities. The invitation link resolves an
// invitation; THIS email carries the short-lived proof that the person acting
// on it actually controls the address the studio recorded. Redeem and decline
// both require it.
//
// ===========================================================================
// WHY A CODE AND NOT A LINK
// ===========================================================================
//
// A proof delivered as a URL would be a second bearer credential, and would
// undo the separation it exists to create:
//
//   * it would have to be registered in lib/security/token-routes.ts and kept
//     out of Referer headers, crawlers and telemetry, exactly like the
//     invitation URL — a second credential surface to defend;
//   * clicked from a phone while the invitation page is open on a laptop, it
//     lands in a different browser session and proves nothing about the
//     session that will perform the mutation;
//   * and a forwarded proof email would again carry mutation authority on its
//     own.
//
// A CODE typed back into the already-open invitation page fixes all three: the
// mutation happens in the session that holds the link, and completing it needs
// the link AND the mailbox. That is the property this feature is buying.
//
// ===========================================================================
// THE CODE IS RENDERED, NEVER MINTED, HERE
// ===========================================================================
//
// This module takes `code` as an opaque string and displays it. It does not
// generate it, choose its alphabet, or know its length. The database mints the
// proof, stores only its hash, and owns the expiry — the same shape 0188 uses
// for `new_client_waitlist_invitations.token_hash` and the portal magic link
// uses in lib/portal/tokens.ts. Keeping the alphabet out of this file means the
// display layer can never become a second opinion about what a valid proof is.
//
// `windowMinutes` is likewise DERIVED by the caller from database-owned values
// (`expires_at - issued_at`), never a constant here. A hard-coded TTL in email
// copy is how the value drifts from the value the database enforces. It is the
// AUTHORISED WINDOW rather than the remaining time, which keeps this payload a
// pure function of the challenge — see the field's own note for why the
// idempotency key now depends on that.
//
// ===========================================================================
// WHAT THIS EMAIL DELIBERATELY OMITS
// ===========================================================================
//
//   * The invitation URL. Re-sending the link beside the code would put both
//     factors in one message and defeat the split.
//   * The recipient's name, their queue position, and any clinical content —
//     for the same reasons the invitation template declines them.
//   * The code in the SUBJECT. A subject reaches a locked-screen notification
//     and a shared-inbox preview pane; banks accept that trade, Hone does not
//     need to, because the person is already looking at the page that asked
//     for the code.
//
// Pure module: no I/O, no env reads, no server-only import, no provider.

export type WaitlistRecipientProofEmailInput = {
  /** Studio display name. Rendered as text only; never used to build a header. */
  studioName: string;
  /**
   * The proof code, already formatted for display by its owner. Opaque here:
   * this module renders whatever string it is given and asserts nothing about
   * its alphabet or length.
   */
  code: string;
  /**
   * The challenge's AUTHORISED WINDOW in whole minutes — what the database
   * granted when it minted the proof, not how much of it is left.
   *
   * THIS MUST NOT BE THE REMAINING TIME, and the reason is not cosmetic. The
   * proof send keys its provider idempotency on the challenge alone, because a
   * payload digest would carry the code to the provider and make the header a
   * verifier for it. Losing the digest means the key no longer tracks the
   * bytes, so `new-client-waitlist-send.ts`'s standing corollary becomes
   * load-bearing here: the payload must be a PURE FUNCTION of the event.
   * Remaining time is a wall clock, so two attempts under one challenge would
   * render different bytes under one key and the provider would answer
   * `invalid_idempotent_request` instead of replaying.
   *
   * The authorised window is stable for the life of the challenge and is still
   * derived from database-owned values (`expires_at - issued_at`), never from a
   * constant in this module. The email is sent immediately after the mint, so
   * it is also what the recipient actually has.
   *
   * This is the CHALLENGE window. It is not the mutation-capability ceiling
   * that B1/B1.5c caps at 30 minutes — a different object, minted later by
   * `completeRecipientProof`, which this template never describes.
   */
  windowMinutes: number;
  /**
   * What the code will authorize, so the email states the consequence rather
   * than a generic "verify". A proof minted for a decline must not read as a
   * booking confirmation.
   */
  action: "book" | "decline";
};

export type WaitlistRecipientProofEmail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * Subject.
 *
 * KNOWN LIMITATION, recorded rather than papered over: Gmail and Outlook thread
 * on normalized subject, so repeated proof emails collapse into one thread and
 * the newest can sit below stale ones — the exact failure PR #127 fixed for the
 * magic link by rewording its subject. That remedy does not transfer here,
 * because a proof may legitimately be requested several times in a row and
 * there is no honest wording that differs per send.
 *
 * The mitigation is in the BODY instead: it states plainly that any earlier
 * code has stopped working, so a reader who opens the wrong message in the
 * thread is told why it failed rather than being left to guess. Putting the
 * code in the subject would defeat threading but leaks it to notification
 * previews, which is the worse trade.
 */
export function waitlistRecipientProofSubject(studio: string): string {
  return `Your ${studio} confirmation code`;
}

/** Whole minutes, phrased naturally. Falls back rather than rendering "0 minutes". */
export function minutesPhrase(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "a few minutes";
  const whole = Math.floor(minutes);
  if (whole <= 0) return "a few minutes";
  return whole === 1 ? "1 minute" : `${whole} minutes`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildWaitlistRecipientProofEmail(
  input: WaitlistRecipientProofEmailInput,
): WaitlistRecipientProofEmail {
  const studio = input.studioName.trim() || "your studio";
  const code = input.code.trim();
  const ttl = minutesPhrase(input.windowMinutes);
  const subject = waitlistRecipientProofSubject(studio);

  // The consequence, stated in the recipient's terms. "Confirm" is used for
  // both branches; what differs is WHAT is being confirmed.
  const consequence =
    input.action === "decline"
      ? `turn down the opening at ${studio}`
      : `book your consultation with ${studio}`;

  const text =
    `Your confirmation code is ${code}\n\n` +
    `Enter it on the page you already have open to ${consequence}.\n\n` +
    `The code expires in ${ttl} and can be used once. ` +
    `If you asked for a new code, any earlier code has already stopped working.\n\n` +
    `If you did not ask for this, you can ignore this email — nothing will ` +
    `happen without the code.\n\n` +
    `${studio} via Hone\n`;

  const studioH = escapeHtml(studio);
  const codeH = escapeHtml(code);
  const ttlH = escapeHtml(ttl);
  const consequenceH = escapeHtml(consequence);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          Your confirmation code.
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          Enter this code on the page you already have open to ${consequenceH}.
        </td></tr>
        <tr><td style="padding:0 0 20px 0;">
          <div style="display:inline-block; padding:18px 28px; background:#FFFFFF; border:1px solid #E5E2DA; border-radius:6px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:30px; font-weight:600; letter-spacing:0.28em; line-height:1;">
            ${codeH}
          </div>
        </td></tr>
        <tr><td style="padding:20px 0 0 0; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          The code expires in ${ttlH} and can be used once. If you asked for a new code, any earlier code has already stopped working.
        </td></tr>
        <tr><td style="padding:12px 0 24px 0; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          If you did not ask for this, you can ignore this email — nothing will happen without the code.
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

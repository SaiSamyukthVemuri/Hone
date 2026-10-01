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
// THE EMAIL IDENTIFIES THE STUDIO BEFORE ANY CLICK
// ===========================================================================
//
// P1 CLIENT TRUST. This email previously carried a constant subject ("Your
// invitation to book"), no studio name in the body, and a line telling the
// recipient that "opening the link will show you which studio is offering it".
// A real prospect could not tell who was inviting them until AFTER clicking an
// unfamiliar link — which is the shape of a phishing message, not an
// invitation from their own studio. The studio name now appears in the
// subject, the heading, the first body sentence and the footer.
//
// WHY THE PREVIOUS "NO STUDIO-DERIVED VALUE" RULE IS RETIRED
// ----------------------------------------------------------
//
// That rule was never about taste; it was an idempotency argument, and it has
// been re-checked against the sender's CURRENT contract rather than preserved
// on inertia. The argument ran: this send passes `payloadCarriesSecret`, so
// the provider key is event-only and carries no payload digest
// (`waitlistEventOnlyIdempotencyKey(namespace, studioId, invitationId)`);
// therefore the payload must be a pure function of the invitation, or two
// attempts under one key render different bytes and the provider answers
// `invalid_idempotent_request` instead of replaying.
//
// The premise that fails is "two attempts". Producing different bytes under
// one key needs a SECOND INVOCATION carrying the same invitation id, and
// lib/waitlist/delivery/send.ts forbids exactly that:
//
//   * 0193 mints the invitation id and the raw token once, and the token is
//     never persisted — so nothing in the system can rebuild this email;
//   * there is no supported "send this invitation again later" operation, and
//     `sameEventRetryAllowed` is typed as the literal `false` so a future
//     branch cannot opt out without a compile error;
//   * an operator's "Resend invitation" is a REISSUE — a new invitation id and
//     a new token, hence a NEW key;
//   * the one retry that is permitted never leaves a single invocation: it
//     reuses the SAME in-memory payload object, so its bytes are identical
//     whatever they contain.
//
// send.ts already draws this conclusion for a strictly larger exposure: "The
// payload is a pure function of the invitation per BUILD, not across builds: a
// deployment can change the template, FROM_ADDRESS or URL construction.
// Same-key/different-bytes would need a SECOND invocation holding the OLD raw
// token — which the law above forbids." A studio rename is a smaller version
// of a template change, and is closed by the same law.
//
// The corroboration is in the sibling template. The RECIPIENT PROOF email
// carries the studio name today, under the identical event-only key shape, and
// send.ts justifies it in these words: "Each challenge is sent once, and a
// resend MINTS A NEW CHALLENGE and therefore a new id, so two independently
// rendered payloads never meet under one key." One invitation id is one
// delivery event in exactly the same way.
//
// WHAT IS *NOT* CHANGED HERE. The From header and Reply-To stay Hone's
// platform identity. That is a different axis — it needs a studio-sender
// contract review of its own — and this hotfix deliberately does not touch it.
// The send therefore remains correctly declared in the
// PLATFORM_IDENTITY_CLIENT_CALLERS list of
// tests/source-guards/client-facing-email-identity.test.ts, which classifies
// call sites by `studioIdentity`, not by body copy.
//
// ===========================================================================
// WHAT THIS EMAIL DELIBERATELY OMITS
// ===========================================================================
//
//   * THE RECIPIENT'S NAME. Same reasoning as the portal magic link: an email
//     that is forwarded, quoted or intercepted should leak no identity. The
//     waitlist entry holds `name`, so naming them would be easy and is
//     deliberately declined. Naming the STUDIO is the opposite trade: it tells
//     the recipient who is writing to them without revealing who they are.
//   * THE RECIPIENT'S POSITION IN THE QUEUE. 0185 refuses to store a position
//     or a cached rank at all; inventing one for email copy would manufacture
//     a fact the database declines to keep.
//   * ANY CLINICAL CONTENT. A waitlist prospect is not a client (0185), so
//     there is nothing clinical to include and no client record to reference.
//   * THE PROOF CODE, AND ANY DESCRIPTION OF ITS MECHANISM. The security line
//     states that verification IS REQUIRED, in mechanism-neutral words, so the
//     copy does not have to move when the proof mechanism does. It says "you
//     will need to verify", not "may": both actions hard-gate on a capability
//     (`declineInvitationAction` and the booking path in
//     app/invitation/[token]/actions.ts both refuse without one), so "may"
//     understated a mandatory step and contradicted the sentence before it.
//   * A RELATIVE EXPIRY. The email states an absolute instant, because a
//     duration is only true at one moment and a delayed send makes it false.
//   * THE EXPIRY AS A HARD-CODED STRING. The invitation TTL is owned by
//     `issue_new_client_waitlist_invitation` (0189: `p_ttl_hours`, default 72,
//     clamped 1..168) and stored on `new_client_waitlist_invitations.expires_at`
//     by a server-owned trigger. The caller passes the phrase derived from that
//     stored value; this module never guesses it.
//
// Pure module: no I/O, no env reads, no server-only import, no provider.

export type WaitlistInvitationEmailInput = {
  /**
   * The studio's display name, server-resolved by the caller from
   * `studios.name`. Rendered in the subject, the heading, the opening body
   * sentence and the footer, so the recipient knows who is inviting them
   * before deciding whether to trust the link.
   *
   * Blank is tolerated rather than trusted: a studio with no name is a data
   * defect, and inventing a placeholder identity would be worse than naming
   * nobody. An empty value falls back to the previous unidentified copy.
   */
  studioName: string;
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
   * state: "expires in 3 days" is false the moment delivery is delayed. An
   * absolute instant stays true however late the message arrives.
   */
  expiresAtLabel: string;
};

export type WaitlistInvitationEmail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * The subject used when no studio name is available. Retained as the explicit
 * degenerate case, not as the normal one: a prospect who cannot see who is
 * writing is the defect this template was changed to fix.
 */
export const WAITLIST_INVITATION_SUBJECT_UNIDENTIFIED = "Your invitation to book";

/**
 * Subject. Names the studio, so the recipient can identify the sender from the
 * inbox list without opening anything.
 *
 * The consultation type stays GENERIC. A new-client waitlist invitation is
 * issued for any service `isConsultationService` accepts — that predicate
 * keys on the `consultation` MODALITY, so a service named "Laser" or
 * "Skincare" qualifies (tests/db/waitlist-admission-command.db.test.ts pins
 * exactly that row as eligible). Saying "electrolysis consultation" would
 * misdescribe the appointment for every studio that is not an electrolysis
 * studio. Naming the actual service would need it threaded through delivery,
 * which is a wider change than this hotfix.
 *
 * No "[HONE WAITLIST]" prefix — that marker exists for the STUDIO-facing
 * notification in templates/new-client-waitlist.ts, where operators build
 * inbox rules on it, and it is operational vocabulary that does not belong in
 * a prospect's inbox. Carries no code, no token and no timestamp, matching the
 * rule the magic-link template states for its own subject.
 */
export function waitlistInvitationSubject(studioName: string): string {
  const studio = studioName.trim();
  return studio
    ? `Your invitation to book a consultation with ${studio}`
    : WAITLIST_INVITATION_SUBJECT_UNIDENTIFIED;
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
  const studio = input.studioName.trim();
  const ttl = input.expiresAtLabel.trim() || "the time stated by the studio";
  const subject = waitlistInvitationSubject(studio);

  // The identified copy is the normal path. The unidentified fallback is the
  // previous wording, kept so a studio with no name is no worse off than
  // before this change rather than being handed an odd half-sentence.
  const heading = studio
    ? `${studio} has invited you to book.`
    : "A spot is available.";
  const lead = studio
    ? `A consultation opening is available at ${studio}. Choose a time that works for you.`
    : "A consultation opening is available, and you can choose a time that suits you. Opening the link will show you which studio is offering it.";
  const cta = studio ? "Choose a consultation time" : "See the opening";
  const footer = studio ? `${studio} via Hone` : "Hone";

  const text =
    `${heading}\n\n` +
    `${lead}\n\n` +
    `${url}\n\n` +
    `This invitation expires ${ttl}.\n\n` +
    // MECHANISM-NEUTRAL, AND NOT OPTIONAL. The previous wording described "a
    // short confirmation code emailed to this address", which pinned
    // prospect-facing copy to one implementation of recipient proof. This
    // states WHAT must happen without describing HOW, so the proof mechanism
    // can change without this sentence becoming a lie.
    //
    // "will need to", never "may": verification is mandatory on both branches
    // — declineInvitationAction and the booking path both return the
    // capability-required state when readCapability yields nothing — so "may"
    // understated a required step and contradicted the clause before it. This
    // removes nothing from the code; the proof requirement is untouched.
    `For your security, opening the link is not enough on its own. When you ` +
    `choose to book or decline, you will need to verify this email ` +
    `address.\n\n` +
    `If you no longer want to hear about openings, reply to this email and ask ` +
    `to be taken off the list.\n\n` +
    `${footer}\n`;

  const urlH = escapeHtml(url);
  const ttlH = escapeHtml(ttl);
  const headingH = escapeHtml(heading);
  const leadH = escapeHtml(lead);
  const ctaH = escapeHtml(cta);
  const footerH = escapeHtml(footer);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          ${headingH}
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          ${leadH}
        </td></tr>
        <tr><td style="padding:0 0 20px 0;">
          <a href="${urlH}" style="display:inline-block; padding:14px 24px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px; letter-spacing:0.02em;">
            ${ctaH}
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
          For your security, opening the link is not enough on its own. When you choose to book or decline, you will need to verify this email address.
        </td></tr>
        <tr><td style="padding:0 0 24px 0; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.65; color:#6B6B6B;">
          If you no longer want to hear about openings, reply to this email and ask to be taken off the list.
        </td></tr>
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          ${footerH}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

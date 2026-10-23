// ===========================================================================
// NEW-CLIENT WAITLIST EMAIL TEMPLATES
// ===========================================================================
//
// Two pure builders (no I/O, no env, no clock):
//
//   1. buildNewClientWaitlistStudioEmail — the OPERATIONAL notice to the
//      studio. In V1 this email IS the record: no durable queue, no client row,
//      no appointment row. The fixed, filterable "[HONE WAITLIST]" subject
//      prefix exists so the studio can label and route it.
//
//   2. buildNewClientWaitlistClientEmail — the best-effort courtesy
//      acknowledgement. It promises nothing: no date, no queue position, no
//      priority, no acceptance.
//
// ===========================================================================
// WAIT-EMAIL-BRAND-01 — BOTH NOW USE THE HONE CLIENT-EMAIL SHELL
// ===========================================================================
//
// These were the last two client-facing emails still rendering as a bare
// `<div>` with no wordmark, no hierarchy and no relationship to the rest of
// the system. Opened in a real inbox the acknowledgement read as an unfinished
// system email: a large empty beige field, the studio's identity buried inside
// a paragraph, and nothing structuring what happens next.
//
// The shell here is NOT new. It is the one already shipped by
// templates/appointment.ts, templates/reminders.ts and
// templates/portal-magic-link.ts, adopted token for token:
//
//   #FAFAF7 page · centered 560px table · 40px/20px page padding ·
//   Georgia 18px wordmark · Georgia 28px headline · system-sans body ·
//   #0A0A0A ink · #6B6B6B secondary · #E5E2DA rules ·
//   #F4F1EA / #C9C4B6 inset panel · 11px 0.15em uppercase labels
//
// Table layout and inline styles throughout, because an email client is not a
// browser: no <style> block, no flexbox, no grid, no external anything.
//
// DELIBERATELY NO CALL TO ACTION. Every sibling template ends in a button
// because each has somewhere to send the reader. This one does not: there is
// nothing for the recipient to do yet, and inventing a button would imply
// otherwise. The absence is the design, which is why it is pinned by a test.
//
// WHAT THE REDESIGN DID NOT CHANGE: both subjects, the sender identity, the
// recipients, the set of facts stated, and the promise this email does not
// make. It is a presentation change over the same words.
//
// PAYLOAD LIMITS. These may carry name / email / optional phone / studio name.
// Never clinical or health data, intake responses, payment data, capacity
// metrics, environment values, or another client's information — none of which
// this feature ever loads.
//
// INJECTION. Every interpolated value is UNTRUSTED PUBLIC INPUT. The HTML
// branch escapes each one; the text branch is not markup. Same local escapeHtml
// convention as reminders.ts / intake-reminder.ts.
//
// DETERMINISM IS LOAD-BEARING. The provider idempotency key is derived from the
// rendered payload bytes, and the provider rejects one key presented with two
// different payloads. So these builders must be a PURE FUNCTION of the
// submission: no wall clock, no nonce, nothing that varies between two
// submissions of the same details.
//
// The studio notice therefore carries NO "Joined:" timestamp, and deliberately
// does not invent one: with no durable waitlist row there is no authoritative
// business time to state, and the inbox already stamps its own receipt time,
// which is the honest operational record for V1. A wall clock in the body would
// make an identical resubmission render different bytes and turn a duplicate —
// the case idempotency exists to collapse — into a hard refusal.
//
// A TEMPLATE EDIT MOVES THE KEY, AND THAT IS THE PRE-EXISTING CONTRACT. The key
// is a digest of the payload, so this redesign changes it for every future
// submission. That is the same cross-build behaviour any copy fix has always
// had here: determinism is required WITHIN a build, between the first attempt
// and its bounded retry, which hold the same in-memory payload. Nothing about
// this change is new in kind.
// ===========================================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Fixed, human-filterable subject prefix. Operators build inbox rules on it. */
export const WAITLIST_SUBJECT_PREFIX = "[HONE WAITLIST]";

const SANS = "-apple-system, system-ui, sans-serif";

// --- The shared Hone client-email shell -----------------------------------
// Lifted verbatim from the three templates named in the header so there is one
// visual contract rather than four drifting copies. Local to this module on
// purpose: hoisting it into a shared helper would touch three shipped
// templates, which is a refactor, not this change.

const SHELL_OPEN = (subject: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>`;

const SHELL_CLOSE = (footer: string) => `
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:${SANS}; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          ${footer}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

const headline = (text: string) => `
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          ${text}
        </td></tr>`;

export function buildNewClientWaitlistStudioEmail(p: {
  studioName: string;
  name: string;
  email: string;
  phone: string | null;
}): { subject: string; html: string; text: string } {
  const subject = `${WAITLIST_SUBJECT_PREFIX} New client · ${p.studioName}`;
  const phoneLine = p.phone ?? "Not provided";

  // UNCHANGED, byte for byte. This slice converts the studio notice's STYLING
  // only; its facts, ordering and plain-text rendering are exactly what they
  // were. Widening operator copy belongs to its own slice.
  const text = [
    "New-client waitlist request",
    "",
    `Name: ${p.name}`,
    `Email: ${p.email}`,
    `Phone: ${phoneLine}`,
    "",
    "This is a waitlist request only.",
    "No appointment has been created.",
  ].join("\n");

  const nameH = escapeHtml(p.name);
  const emailH = escapeHtml(p.email);
  const phoneH = escapeHtml(phoneLine);

  const html =
    SHELL_OPEN(subject) +
    headline("New-client waitlist request.") +
    `
        <tr><td style="padding:24px 0; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; font-family:${SANS}; font-size:15px; line-height:1.8;">
          <strong>${nameH}</strong><br/>
          ${emailH}<br/>
          ${phoneH}
        </td></tr>
        <tr><td style="padding:24px 0 0 0; font-family:${SANS}; font-size:13px; line-height:1.65; color:#6B6B6B;">
          This is a waitlist request only.<br/>
          No appointment has been created.
        </td></tr>` +
    SHELL_CLOSE("Hone");

  return { subject, html, text };
}

export function buildNewClientWaitlistClientEmail(p: {
  studioName: string;
  name: string;
}): { subject: string; html: string; text: string } {
  // UNCHANGED. Pinned by tests/app/book/new-client-waitlist-action.test.ts and
  // seen in real production inboxes; the feedback said the subject and sender
  // identity were the good parts.
  const subject = `You're on the waitlist · ${p.studioName}`;

  // The plain-text branch gets the same hierarchy the HTML now has: a title,
  // a labelled section, and the two no-appointment facts standing alone
  // instead of being folded into one sentence. Same facts, same order.
  const text = [
    "You're on the waitlist.",
    "",
    `Hi ${p.name},`,
    "",
    `You're on the new-client waitlist for ${p.studioName}.`,
    "",
    "WHAT HAPPENS NEXT",
    "We'll contact you when consultation and treatment availability can be offered.",
    "",
    "No appointment has been booked.",
    "No appointment time has been reserved.",
    "",
    "You don't need to submit the waitlist form again.",
    "",
    `${p.studioName} via Hone`,
  ].join("\n");

  const nameH = escapeHtml(p.name);
  const studioH = escapeHtml(p.studioName);

  const html =
    SHELL_OPEN(subject) +
    headline("You&rsquo;re on the waitlist.") +
    `
        <tr><td style="padding-bottom:20px; font-family:${SANS}; font-size:16px; line-height:1.6;">
          Hi ${nameH},
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:${SANS}; font-size:16px; line-height:1.6;">
          You&rsquo;re on the new-client waitlist for <strong>${studioH}</strong>.
        </td></tr>
        <tr><td style="padding:24px 0; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA;">
          <p style="margin:0 0 8px 0; font-family:${SANS}; font-size:11px; font-weight:600; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">What happens next</p>
          <p style="margin:0; font-family:${SANS}; font-size:15px; line-height:1.6;">
            We&rsquo;ll contact you when consultation and treatment availability can be offered.
          </p>
        </td></tr>
        <tr><td style="padding:24px 0 0 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F1EA; border-left:3px solid #C9C4B6;">
            <tr><td style="padding:16px 20px; font-family:${SANS}; font-size:14px; line-height:1.7; color:#0A0A0A;">
              No appointment has been booked.<br/>
              No appointment time has been reserved.
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 0 24px 0; font-family:${SANS}; font-size:13px; line-height:1.65; color:#6B6B6B;">
          You don&rsquo;t need to submit the waitlist form again.
        </td></tr>` +
    SHELL_CLOSE(`${studioH} via Hone`);

  return { subject, html, text };
}

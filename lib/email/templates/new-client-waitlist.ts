// ===========================================================================
// P0 EMERGENCY — NEW-CLIENT WAITLIST EMAIL TEMPLATES
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

export function buildNewClientWaitlistStudioEmail(p: {
  studioName: string;
  name: string;
  email: string;
  phone: string | null;
}): { subject: string; html: string; text: string } {
  const subject = `${WAITLIST_SUBJECT_PREFIX} New client · ${p.studioName}`;
  const phoneLine = p.phone ?? "Not provided";

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

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:24px; background-color:#FAFAF7; color:#0A0A0A;">
  <div style="max-width:560px; margin:0 auto; font-family:${SANS}; font-size:15px; line-height:1.6;">
    <p style="margin:0 0 20px; font-size:18px; font-weight:600;">
      New-client waitlist request
    </p>
    <p style="margin:0 0 20px;">
      <strong>Name:</strong> ${escapeHtml(p.name)}<br />
      <strong>Email:</strong> ${escapeHtml(p.email)}<br />
      <strong>Phone:</strong> ${escapeHtml(phoneLine)}
    </p>
    <p style="margin:0; color:#6B6B6B; font-size:13px;">
      This is a waitlist request only.<br />
      No appointment has been created.
    </p>
  </div>
</body></html>`;

  return { subject, html, text };
}

export function buildNewClientWaitlistClientEmail(p: {
  studioName: string;
  name: string;
}): { subject: string; html: string; text: string } {
  const subject = `You're on the waitlist · ${p.studioName}`;

  const text = [
    `Hi ${p.name},`,
    "",
    `You're on ${p.studioName}'s new-client waitlist.`,
    "",
    "We'll contact you when consultation and treatment availability can be offered.",
    "",
    "This is not an appointment, and no appointment time has been reserved.",
    "",
    "You do not need to submit the waitlist form again.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:24px; background-color:#FAFAF7; color:#0A0A0A;">
  <div style="max-width:560px; margin:0 auto; font-family:${SANS}; font-size:15px; line-height:1.6;">
    <p style="margin:0 0 20px;">Hi ${escapeHtml(p.name)},</p>
    <p style="margin:0 0 20px;">
      You&rsquo;re on ${escapeHtml(p.studioName)}&rsquo;s new-client waitlist.
    </p>
    <p style="margin:0 0 20px;">
      We&rsquo;ll contact you when consultation and treatment availability can
      be offered.
    </p>
    <p style="margin:0 0 20px;">
      This is not an appointment, and no appointment time has been reserved.
    </p>
    <p style="margin:0; color:#6B6B6B; font-size:13px;">
      You do not need to submit the waitlist form again.
    </p>
  </div>
</body></html>`;

  return { subject, html, text };
}

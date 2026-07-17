import { localTimeString12h } from "@/lib/booking/tz";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dayLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

// PR #157 patch. Email time range label, used by both the client
// confirmation email and the practitioner notification email. Uses
// the 12h localTimeString12h helper (returns "11:00 AM" / "12:00 PM")
// and the ASCII " to " separator the bug spec called for
// ("11 AM to 12 PM"). The previous shape was
// `${localTimeString(...)} – ${localTimeString(...)}` which produced
// "11:00 – 12:00" (24h, en-dash) and matched the client confusion
// report. Practitioner notification gets the same 12h treatment
// because Chloe (the practitioner) also reads these on mobile where
// AM/PM is universally clearer than a bare 24h hour.
function rangeLabel(start: Date, end: Date, tz: string): string {
  return `${localTimeString12h(start, tz)} to ${localTimeString12h(end, tz)}`;
}

// PR #160. Prior versions of this template carried a hardcoded
// "Please arrive 5 minutes early. Wear comfortable clothing. Avoid
// caffeine before your appointment." paragraph that rendered ABOVE
// the per-service preCareInstructions block. Chloe's smoke-test
// feedback: the studio (and Laura later) must own that wording, and
// rendering both the hardcoded default + the per-service text felt
// like two prep sections fighting each other. The constant is gone;
// the per-service services.pre_care_instructions field (migration
// 0025) is now the single source of truth, edited via Settings ->
// Services. When a service has no prep text on file the email simply
// omits the prep block.

type ConfirmationToClient = {
  clientName: string;
  studioName: string;
  studioAddress: string | null;
  studioEmail: string;
  practitionerName: string | null;
  serviceName: string;
  durationMinutes: number;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  cancellationUrl: string;
  rescheduleUrl: string | null;
  intakeUrl: string | null;
  // Token-FREE studio portal login URL (/portal/login?studio=slug). NOT a
  // one-time magic link — the client enters their email to receive a secure
  // sign-in link. Optional so non-sender callers can omit it.
  portalLoginUrl?: string | null;
  preCareInstructions: string | null;
  // Optional client-facing treatment-time line. Rendered only when the
  // studio toggle is on AND the field is set. Format: "Treatment time so
  // far: 23h 45m · This will be session 19" or "This will be Sarah's
  // first electrolysis session".
  treatmentTimeLine: string | null;
};

export function buildClientConfirmationEmail(p: ConfirmationToClient): {
  subject: string;
  html: string;
  text: string;
} {
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = rangeLabel(p.startsAt, p.endsAt, p.timezone);
  const subject = `Appointment confirmed: ${p.serviceName} with ${p.studioName} on ${dayStr}`;
  const safeClient = escapeHtml(p.clientName);
  const safeStudio = escapeHtml(p.studioName);
  const safeService = escapeHtml(p.serviceName);
  const safePract = p.practitionerName ? escapeHtml(p.practitionerName) : null;
  const safeAddress = p.studioAddress ? escapeHtml(p.studioAddress) : null;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          Your appointment is confirmed.
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          ${safeClient},
        </td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          You're booked for <strong>${safeService}</strong>${safePract ? ` with ${safePract}` : ""} at <strong>${safeStudio}</strong>.
        </td></tr>
        <tr><td style="padding-bottom:24px; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; padding-top:24px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.8;">
          <strong>${escapeHtml(dayStr)}</strong><br/>
          ${escapeHtml(timeStr)} (${escapeHtml(p.timezone)})<br/>
          Duration: ${p.durationMinutes} minutes
          ${safeAddress ? `<br/><br/>${safeAddress}` : ""}
          ${p.treatmentTimeLine ? `<br/><br/><span style="font-family:Georgia, serif; font-style:italic; color:#6B6B6B;">${escapeHtml(p.treatmentTimeLine)}</span>` : ""}
        </td></tr>
        ${
          p.preCareInstructions
            ? `<tr><td style="padding:24px 0 20px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F1EA; border-left:3px solid #C9C4B6;">
                  <tr><td style="padding:16px 20px;">
                    <p style="margin:0 0 8px 0; font-family:-apple-system, system-ui, sans-serif; font-size:11px; font-weight:600; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">Before your appointment</p>
                    <p style="margin:0; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; white-space:pre-wrap;">${escapeHtml(p.preCareInstructions)}</p>
                  </td></tr>
                </table>
              </td></tr>`
            : ""
        }
        ${
          p.intakeUrl
            ? `<tr><td style="padding:20px 0 8px 0; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;">
                Before your appointment, please complete your health intake form:
              </td></tr>
              <tr><td style="padding-bottom:8px;">
                <a href="${p.intakeUrl}" style="display:inline-block; padding:12px 20px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px;">
                  Complete intake form
                </a>
              </td></tr>
              <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B;">
                This takes about 7 to 10 minutes. Your electrologist will review it before your appointment.
              </td></tr>`
            : ""
        }
        <tr><td style="padding-bottom:32px;">
          ${
            p.rescheduleUrl
              ? `<a href="${p.rescheduleUrl}" style="display:inline-block; padding:12px 20px; margin-right:12px; background:#0A0A0A; color:#FFFFFF; font-family:-apple-system, system-ui, sans-serif; font-size:14px; font-weight:500; text-decoration:none; border-radius:6px;">Reschedule</a>`
              : ""
          }
          <a href="${p.cancellationUrl}" style="font-family:-apple-system, system-ui, sans-serif; font-size:13px; color:#0A0A0A; letter-spacing:0.1em; text-transform:uppercase;">
            Cancel
          </a>
        </td></tr>
        ${
          p.portalLoginUrl
            ? `<tr><td style="padding:20px 0; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; color:#0A0A0A;">
          View your forms, appointments, and care instructions in your <a href="${p.portalLoginUrl}" style="color:#0A0A0A; text-decoration:underline;">secure client portal</a>.
        </td></tr>`
            : ""
        }
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          Hone &middot; Charting software for electrolysis and laser practitioners
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${p.clientName},

Your appointment is confirmed.

${p.serviceName}${p.practitionerName ? ` with ${p.practitionerName}` : ""} at ${p.studioName}

${dayStr}
${timeStr} (${p.timezone})
Duration: ${p.durationMinutes} minutes
${p.studioAddress ? `\n${p.studioAddress}\n` : ""}
${p.treatmentTimeLine ? `${p.treatmentTimeLine}\n` : ""}
${p.preCareInstructions ? `\nBefore your appointment:\n${p.preCareInstructions}\n` : ""}
${p.intakeUrl ? `\nBefore your appointment, please complete your health intake form (about 7 to 10 minutes):\n${p.intakeUrl}\n` : ""}
${p.rescheduleUrl ? `Reschedule: ${p.rescheduleUrl}\n` : ""}
Need to cancel? ${p.cancellationUrl}
${p.portalLoginUrl ? `\nView your forms, appointments, and care instructions in your secure client portal:\n${p.portalLoginUrl}\n` : ""}
Hone. Charting software for electrolysis and laser practitioners.
hone.care
`;

  return { subject, html, text };
}

type NotifyPractitioner = {
  practitionerName: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  studioName: string;
  serviceName: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  notes: string | null;
  appointmentUrl: string;
  // PR #163. Practitioner-facing attribution from the public booking
  // form ("How did you hear about us?"). Already mapped through
  // referralSourceLabel by the caller; null when the visitor declined
  // to answer. NOT rendered in any client-facing email.
  referralSourceLabel: string | null;
};

export function buildPractitionerNotificationEmail(p: NotifyPractitioner): {
  subject: string;
  html: string;
  text: string;
} {
  const dayStr = dayLabel(p.startsAt, p.timezone);
  const timeStr = rangeLabel(p.startsAt, p.endsAt, p.timezone);
  const subject = `New booking: ${p.clientName} – ${p.serviceName} on ${dayStr}`;
  const safeClient = escapeHtml(p.clientName);
  const safeService = escapeHtml(p.serviceName);
  const safePract = escapeHtml(p.practitionerName);
  const safeStudio = escapeHtml(p.studioName);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:24px; letter-spacing:-0.02em; line-height:1.2;">
          New booking at ${safeStudio}.
        </td></tr>
        <tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;">
          ${safePract},
        </td></tr>
        <tr><td style="padding-bottom:24px; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; padding-top:24px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.8;">
          <strong>${safeClient}</strong><br/>
          ${escapeHtml(p.clientEmail)}${p.clientPhone ? ` &middot; ${escapeHtml(p.clientPhone)}` : ""}<br/><br/>
          ${safeService}<br/>
          <strong>${escapeHtml(dayStr)}</strong><br/>
          ${escapeHtml(timeStr)} (${escapeHtml(p.timezone)})
          ${p.notes ? `<br/><br/>Notes: ${escapeHtml(p.notes)}` : ""}
          ${p.referralSourceLabel ? `<br/><br/>How they heard about us: ${escapeHtml(p.referralSourceLabel)}` : ""}
        </td></tr>
        <tr><td style="padding-top:24px;">
          <a href="${p.appointmentUrl}" style="font-family:-apple-system, system-ui, sans-serif; font-size:13px; color:#0A0A0A; letter-spacing:0.1em; text-transform:uppercase;">
            Open in Hone
          </a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `New booking at ${p.studioName}.

${p.clientName}
${p.clientEmail}${p.clientPhone ? `, ${p.clientPhone}` : ""}

${p.serviceName}
${dayStr}
${timeStr} (${p.timezone})
${p.notes ? `\nNotes: ${p.notes}\n` : ""}
${p.referralSourceLabel ? `How they heard about us: ${p.referralSourceLabel}\n` : ""}
Open in Hone: ${p.appointmentUrl}
`;

  return { subject, html, text };
}

// Who performed the cancellation. Server-derived from the authoritative
// cancellation path (never a browser-supplied value); see the derivation at each
// call site (public token cancel = the appointment's client; practitioner cancel =
// the authenticated practitioner/owner; an automated cancel = the system).
export type CancellationActorRole = "client" | "practitioner" | "owner" | "system";

// Human-readable role label for the practitioner-facing email. "owner" reads as
// "Studio owner" so the recipient never sees an internal enum value.
export function cancellationActorRoleLabel(role: CancellationActorRole): string {
  switch (role) {
    case "client":
      return "Client";
    case "practitioner":
      return "Practitioner";
    case "owner":
      return "Studio owner";
    case "system":
      return "System";
  }
}

// "Cancelled by" value for the email. With a display name → "<name> — <Role>";
// with no usable name → just the role label (safe fallback per the spec, e.g.
// "Cancelled by: Client"). No IDs/tokens/emails are ever placed here.
export function cancellationActorSummary(
  actorName: string | null | undefined,
  role: CancellationActorRole,
): string {
  const label = cancellationActorRoleLabel(role);
  const name = actorName?.trim();
  return name ? `${name} — ${label}` : label;
}

// Month + day only (e.g. "July 21"), studio-timezone aware, for the subject line.
function monthDayLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "long",
    day: "numeric",
  }).format(d);
}

type CancellationEmail = {
  recipientName: string;
  // The appointment's client, shown on the practitioner-facing email so the
  // recipient sees WHOSE appointment was cancelled independently of who cancelled.
  clientName: string | null;
  studioName: string;
  serviceName: string;
  durationMinutes: number;
  startsAt: Date;
  timezone: string;
  // Who cancelled — server-derived. actorName is the display name (or null for the
  // role-only fallback); actorRole drives the label + the client-facing "by the
  // studio" wording.
  actorName: string | null;
  actorRole: CancellationActorRole;
  reason: string | null;
  isClient: boolean; // recipient is the client
  rebookUrl?: string;
};

export function buildCancellationEmail(p: CancellationEmail): {
  subject: string;
  html: string;
  text: string;
} {
  const dayStr = dayLabel(p.startsAt, p.timezone);
  // PR #157 patch. Cancellation email rendered the start time in 24h
  // (e.g. "Tuesday, June 9, 2026 at 11:00"); the recipient could
  // misread an early-morning vs midday cancellation. Switched to the
  // 12h client-facing helper so both branches (isClient and not)
  // surface "11:00 AM" / "11:00 PM" unambiguously. The recipient
  // identity does not affect the format because both the client and
  // the studio side benefit from the same disambiguation.
  const timeStr = localTimeString12h(p.startsAt, p.timezone);
  const safeStudio = escapeHtml(p.studioName);
  const safeService = escapeHtml(p.serviceName);

  const htmlShell = (bodyRowsHtml: string, ctaHtml: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:24px; letter-spacing:-0.02em; line-height:1.2;">
          Appointment cancelled.
        </td></tr>
        ${bodyRowsHtml}
        ${ctaHtml}
      </table>
    </td></tr>
  </table>
</body></html>`;

  if (p.isClient) {
    // ---- Client-facing email. Behaviour unchanged: the client never sees which
    // internal actor cancelled, only "your appointment ... was cancelled [by the
    // studio]". ----
    const safeName = escapeHtml(p.recipientName);
    const lead = `Your ${safeService} appointment at ${safeStudio} on <strong>${escapeHtml(dayStr)}</strong> at ${escapeHtml(timeStr)} has been cancelled${p.actorRole !== "client" ? " by the studio" : ""}.`;
    const bodyRowsHtml = `<tr><td style="padding-bottom:20px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;">${safeName},</td></tr>
        <tr><td style="padding-bottom:24px; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;">
          ${lead}
          ${p.reason ? `<br/><br/>Reason: ${escapeHtml(p.reason)}` : ""}
        </td></tr>`;
    const ctaHtml = p.rebookUrl
      ? `<tr><td style="padding-bottom:32px;">
                <a href="${p.rebookUrl}" style="font-family:-apple-system, system-ui, sans-serif; font-size:13px; color:#0A0A0A; letter-spacing:0.1em; text-transform:uppercase;">
                  Book another appointment
                </a>
              </td></tr>`
      : "";
    const text = `${p.recipientName},

Your ${p.serviceName} appointment at ${p.studioName} on ${dayStr} at ${timeStr} has been cancelled${p.actorRole !== "client" ? " by the studio" : ""}.
${p.reason ? `\nReason: ${p.reason}` : ""}
${p.rebookUrl ? `\nBook another: ${p.rebookUrl}` : ""}
`;
    return {
      subject: `Appointment cancelled: ${p.serviceName} at ${p.studioName}`,
      html: htmlShell(bodyRowsHtml, ctaHtml),
      text,
    };
  }

  // ---- Practitioner-facing email. The recipient (studio/owner) must see, at a
  // glance, WHO cancelled, WHOSE appointment, WHEN, WHAT, and WHY. ----
  const cancelledBy = cancellationActorSummary(p.actorName, p.actorRole);
  const actorName = p.actorName?.trim() || null;
  const monthDay = monthDayLabel(p.startsAt, p.timezone);
  // Clearer subject, e.g. "Appointment cancelled by Chloe Vemuri LE: 90 minute
  // session on July 21"; with no name, name-free but still says who by role.
  const subject = actorName
    ? `Appointment cancelled by ${actorName}: ${p.serviceName} on ${monthDay}`
    : `Appointment cancelled by the ${cancellationActorRoleLabel(p.actorRole).toLowerCase()}: ${p.serviceName} on ${monthDay}`;

  // Ordered, labelled rows. Every value is a display field (name/label/time/
  // service/duration/reason label) — never an id, token, raw audit JSON, or note.
  const rows: Array<[string, string]> = [];
  if (p.clientName && p.clientName.trim()) rows.push(["Client", p.clientName.trim()]);
  rows.push(["Cancelled by", cancelledBy]);
  rows.push(["Original time", `${dayStr} at ${timeStr}`]);
  rows.push(["Service", `${p.serviceName} (${p.durationMinutes} min)`]);
  rows.push(["Reason", p.reason && p.reason.trim() ? p.reason.trim() : "—"]);

  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 0; font-family:-apple-system, system-ui, sans-serif; font-size:15px; line-height:1.6;"><span style="color:#6B6B6B;">${escapeHtml(label)}:</span> <strong>${escapeHtml(value)}</strong></td></tr>`,
    )
    .join("\n        ");
  const bodyRowsHtml = `<tr><td style="padding-bottom:8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rowsHtml}
          </table>
        </td></tr>`;

  const text = `Appointment cancelled

${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}
`;

  return { subject, html: htmlShell(bodyRowsHtml, ""), text };
}

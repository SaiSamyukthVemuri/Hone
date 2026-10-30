import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmailSafely } from "./send-appointment";
import { resolveReplyTo, studioClientContactEmail } from "@/lib/email/studio-identity";
import { generateCancellationToken } from "@/lib/booking/tokens";
import { clientManagePageAllowed } from "@/lib/booking/client-self-service-policy";
import { loadClientSelfServicePolicy } from "@/lib/booking/client-self-service-policy-store";
import { localLongDate, formatTimeForStudio } from "@/lib/booking/tz";
import { clientPreheader, withPreheader, withTextPreheader } from "@/lib/email/preheader";
import { emailBookingReference } from "@/lib/email/booking-reference";
import { withReference } from "@/lib/email/subject-reference";
import { appointmentEmailAddress } from "@/lib/booking/studio-location";

// Practitioner Move appointment: the NARROW client "appointment updated" notification.
//
// Sent AFTER (and only after) a successful move commit. It reuses the existing safe
// send primitive (sendEmailSafely) + the stateless HMAC manage/reschedule link
// (generateCancellationToken, no stored raw token), and NEVER touches the one-time
// confirmation email/SMS claim slots (reusing them would suppress this move email or
// overwrite the truth of the original confirmation, per the feature contract). It adds
// no migration, no new DB column, and no durable outbox.
//
// SMS is intentionally NOT sent for a move in this feature: the only SMS send paths
// claim the one-time "confirmation" slot (which this must not reuse), and a dedicated
// "moved" SMS type would require a new column/migration (out of scope here). Email is
// the move notification; SMS delivery for moves is a later, separately-scoped decision.
//
// Fail-open + PHI-free: a provider failure returns "degraded" (the appointment stays
// moved) and records only a safe category signal, never a client identity, appointment
// content, or raw provider body.

export type MoveNotificationStatus = "sent" | "skipped" | "degraded";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

async function safeMoveAlert(studioId: string, appointmentId: string, category: string): Promise<void> {
  try {
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    await recordOpsAlert({
      severity: "warning",
      event: "appointment_move_notification_failed",
      message: "Appointment moved but the client update notification could not be delivered.",
      studioId,
      appointmentId,
      route: "lib/email/notify-appointment-moved",
      // Safe category/code only, no client PII, appointment content, or raw provider body.
      safeDetails: { channel: "email", reason: category },
    });
  } catch {
    // alerting is itself fail-open; never surface an alerting error to the move flow.
  }
}

// Item 7: the move can be a time move, a same-time practitioner reassignment, or
// both. The email must be TRUTHFUL for each: a reassignment does not claim the
// time changed. Defaults to "moved" for the pre-Item-7 callers.
export type MoveNotificationKind = "moved" | "reassigned" | "moved_and_reassigned";

/**
 * The "appointment updated" email, as a pure builder (no I/O), so the subject
 * sweep (tests/lib/email/email-subject-sweep.test.ts) can render every kind.
 */
export function buildAppointmentMovedEmail(p: {
  kind: MoveNotificationKind;
  studioName: string;
  // HON-50. The studio's public address, as the confirmation and reminders
  // show it. Omitted or null (a home-based studio) adds nothing.
  studioAddress?: string | null;
  serviceName: string;
  startsAt: Date;
  timezone: string;
  practitionerName: string | null;
  // HON-47. Null when the studio does not offer that path online; the line
  // then names only what IS offered, or how to reach the studio.
  manageUrl: string | null;
  rescheduleUrl: string | null;
  bookingReference: string;
}): { subject: string; html: string; text: string } {
  const { kind, studioName, serviceName, practitionerName, manageUrl, rescheduleUrl } = p;
  const dateStr = localLongDate(p.startsAt, p.timezone);
  const timeStr = formatTimeForStudio(p.startsAt, p.timezone, "12h");
  // SUBJECT RULE (HIPAA-READY-01, #828): no service, date or time in a
  // subject. They stay in the body, which names the new time. The booking
  // reference keeps one booking's updates out of another booking's thread
  // (Codex 4355360162; tests/lib/email/email-subject-sweep.test.ts).
  let subject: string;
  let headline: string;
  let bodyHtml: string;
  let bodyText: string;
  if (kind === "reassigned") {
    // Practitioner changed, TIME UNCHANGED, never claim the time moved.
    const who = practitionerName ? `<strong>${esc(practitionerName)}</strong>` : "a different practitioner";
    const whoText = practitionerName ? practitionerName : "a different practitioner";
    subject = `Your appointment with ${studioName} has been updated`;
    headline = "Your appointment has a new practitioner.";
    bodyHtml = `Your <strong>${esc(serviceName)}</strong> appointment at <strong>${esc(studioName)}</strong> on <strong>${esc(dateStr)} at ${esc(timeStr)}</strong> will now be with ${who}. The time is unchanged.`;
    bodyText = `Your ${serviceName} appointment at ${studioName} on ${dateStr} at ${timeStr} will now be with ${whoText}. The time is unchanged.`;
  } else if (kind === "moved_and_reassigned") {
    const who = practitionerName ? ` with <strong>${esc(practitionerName)}</strong>` : "";
    const whoText = practitionerName ? ` with ${practitionerName}` : "";
    subject = `Your appointment with ${studioName} has been updated`;
    headline = "Your appointment time and practitioner have changed.";
    bodyHtml = `Your <strong>${esc(serviceName)}</strong> appointment at <strong>${esc(studioName)}</strong> has been moved to <strong>${esc(dateStr)} at ${esc(timeStr)}</strong>${who}.`;
    bodyText = `Your ${serviceName} appointment at ${studioName} has been moved to ${dateStr} at ${timeStr}${whoText}.`;
  } else {
    subject = `Your appointment with ${studioName} has been updated`;
    headline = "Your appointment time has changed.";
    bodyHtml = `Your <strong>${esc(serviceName)}</strong> appointment at <strong>${esc(studioName)}</strong> has been moved to <strong>${esc(dateStr)} at ${esc(timeStr)}</strong>. Everything else stays the same.`;
    bodyText = `Your ${serviceName} appointment at ${studioName} has been moved to ${dateStr} at ${timeStr}. Everything else stays the same.`;
  }
  subject = withReference(subject, p.bookingReference);
  // HON-50: where the appointment is, under the details it belongs to.
  const studioAddress = p.studioAddress?.trim() || null;
  if (studioAddress) {
    bodyHtml += `<br/><br/>${esc(studioAddress)}`;
    bodyText += `\n\n${studioAddress}`;
  }

  // PREVIEW RULE (HIPAA-READY-01, #828): a client that strips the preheader
  // filler previews the first body text, so the body opens with a lead that
  // names only the studio. The client's name is not repeated; the service and
  // the new time follow the lead.
  const lead = `${studioName} has updated your appointment. The details are below.`;
  const changeHtml =
    manageUrl && rescheduleUrl
      ? `Need to make a change? <a href="${esc(rescheduleUrl)}">Reschedule</a> or <a href="${esc(manageUrl)}">manage your appointment</a>.`
      : manageUrl
        ? `Need to make a change? <a href="${esc(manageUrl)}">Manage your appointment</a>.`
        : `Need to make a change? Please contact ${esc(studioName)} directly.`;
  const changeText =
    manageUrl && rescheduleUrl
      ? `Manage or reschedule: ${manageUrl}`
      : manageUrl
        ? `Manage your appointment: ${manageUrl}`
        : `Need to make a change? Please contact ${studioName} directly.`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#FAFAF7;color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7;padding:40px 20px;"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
    <tr><td style="padding-bottom:24px;font-family:Georgia,serif;font-weight:700;font-size:18px;">Hone</td></tr>
    <tr><td style="padding-bottom:16px;font-family:Georgia,serif;font-weight:700;font-size:28px;line-height:1.15;">${esc(headline)}</td></tr>
    <tr><td style="padding-bottom:20px;font-family:-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.6;">${esc(lead)}</td></tr>
    <tr><td style="padding-bottom:24px;font-family:-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.6;">
      ${bodyHtml}</td></tr>
    <tr><td style="padding-bottom:16px;font-family:-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.6;">
      ${changeHtml}</td></tr>
  </table>
  </td></tr></table>
</body></html>`;
  return {
    subject,
    html: withPreheader(html, clientPreheader(studioName)),
    text: withTextPreheader(
      `${lead}\n\n${bodyText}\n\nBooking reference: ${p.bookingReference.trim()}\n${changeText}\n`,
      clientPreheader(studioName),
    ),
  };
}

export async function notifyAppointmentMoved(
  admin: SupabaseClient,
  input: {
    appointmentId: string;
    studioId: string;
    appOrigin: string;
    resultKind?: MoveNotificationKind;
  },
): Promise<MoveNotificationStatus> {
  try {
    const { data } = await admin
      .from("appointments")
      .select(
        "id, starts_at, client:clients(name, email), service:services(name), studio:studios(name, timezone, address, owner_email, postcare_contact_email), practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name)",
      )
      .eq("id", input.appointmentId)
      .eq("studio_id", input.studioId)
      .maybeSingle();
    if (!data) return "degraded"; // could not re-load the moved appointment
    const row = data as unknown as {
      id: string;
      starts_at: string;
      client: { name: string | null; email: string | null } | null;
      service: { name: string | null } | null;
      studio: {
        name: string | null;
        timezone: string | null;
        address: string | null;
        owner_email: string | null;
        postcare_contact_email: string | null;
      } | null;
      practitioner: { display_name: string | null } | null;
    };

    const email = row.client?.email ?? null;
    if (!email) return "skipped"; // no client email on file -> nothing to send

    const tz = row.studio?.timezone ?? "America/Toronto";
    const start = new Date(row.starts_at);
    const serviceName = row.service?.name ?? "your appointment";
    const studioName = row.studio?.name ?? "the studio";
    // Post-commit row → the NEW practitioner. Include the display name only when
    // present; never an id. Absent name falls back to neutral phrasing.
    const practitionerName = row.practitioner?.display_name ?? null;

    // Stateless HMAC token (no stored raw token) → the neutral manage + reschedule links.
    const token = generateCancellationToken(row.id, start);
    // HON-47. The studio's client self-service policy decides which links this
    // email may carry. An unreadable policy withdraws them all: the email still
    // delivers, with the contact line, rather than linking into a refusal.
    const policyRead = await loadClientSelfServicePolicy(admin, input.studioId);
    const policy = policyRead.ok ? policyRead.policy : null;
    const manageUrl =
      policy && clientManagePageAllowed(policy) ? `${input.appOrigin}/manage/${token}` : null;
    const rescheduleUrl = policy?.reschedule ? `${input.appOrigin}/reschedule/${token}` : null;

    const { subject, html: htmlWithPreheader, text } = buildAppointmentMovedEmail({
      kind: input.resultKind ?? "moved",
      studioName,
      studioAddress: row.studio ? appointmentEmailAddress(row.studio) : null,
      serviceName,
      startsAt: start,
      timezone: tz,
      practitionerName,
      manageUrl,
      rescheduleUrl,
      bookingReference: emailBookingReference(row.id),
    });

    const res = await sendEmailSafely({
      studioIdentity: {
        displayName: row.studio?.name ?? null,
        replyTo: resolveReplyTo(
          studioClientContactEmail({
            postcare_contact_email: row.studio?.postcare_contact_email ?? null,
            owner_email: row.studio?.owner_email ?? null,
          }),
        ),
      },
      to: email,
      subject,
      html: htmlWithPreheader,
      text,
    });
    if (res.ok) return "sent";
    // Provider failure → degraded + a safe category signal (never the raw provider error).
    await safeMoveAlert(input.studioId, input.appointmentId, res.retryable ? "provider_retryable" : "provider_permanent");
    return "degraded";
  } catch (e) {
    await safeMoveAlert(input.studioId, input.appointmentId, e instanceof Error ? e.name : "unknown");
    return "degraded";
  }
}

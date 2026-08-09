import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmailSafely } from "./send-appointment";
import { generateCancellationToken } from "@/lib/booking/tokens";
import { localLongDate, formatTimeForStudio } from "@/lib/booking/tz";

// Practitioner Move appointment — the NARROW client "appointment updated" notification.
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
// moved) and records only a safe category signal — never a client identity, appointment
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
      // Safe category/code only — no client PII, appointment content, or raw provider body.
      safeDetails: { channel: "email", reason: category },
    });
  } catch {
    // alerting is itself fail-open; never surface an alerting error to the move flow.
  }
}

// Item 7: the move can be a time move, a same-time practitioner reassignment, or
// both. The email must be TRUTHFUL for each — a reassignment does not claim the
// time changed. Defaults to "moved" for the pre-Item-7 callers.
export type MoveNotificationKind = "moved" | "reassigned" | "moved_and_reassigned";

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
        "id, starts_at, client:clients(name, email), service:services(name), studio:studios(name, timezone), practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name)",
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
      studio: { name: string | null; timezone: string | null } | null;
      practitioner: { display_name: string | null } | null;
    };

    const email = row.client?.email ?? null;
    if (!email) return "skipped"; // no client email on file -> nothing to send

    const tz = row.studio?.timezone ?? "America/Toronto";
    const start = new Date(row.starts_at);
    const clientName = row.client?.name ?? "there";
    const serviceName = row.service?.name ?? "your appointment";
    const studioName = row.studio?.name ?? "the studio";
    const dateStr = localLongDate(start, tz);
    const timeStr = formatTimeForStudio(start, tz, "12h");
    // Post-commit row → the NEW practitioner. Include the display name only when
    // present; never an id. Absent name falls back to neutral phrasing.
    const practitionerName = row.practitioner?.display_name ?? null;

    // Stateless HMAC token (no stored raw token) → the neutral manage + reschedule links.
    const token = generateCancellationToken(row.id, start);
    const manageUrl = `${input.appOrigin}/manage/${token}`;
    const rescheduleUrl = `${input.appOrigin}/reschedule/${token}`;

    const kind: MoveNotificationKind = input.resultKind ?? "moved";
    let subject: string;
    let headline: string;
    let bodyHtml: string;
    let bodyText: string;
    if (kind === "reassigned") {
      // Practitioner changed, TIME UNCHANGED — never claim the time moved.
      const who = practitionerName ? `<strong>${esc(practitionerName)}</strong>` : "a different practitioner";
      const whoText = practitionerName ? practitionerName : "a different practitioner";
      subject = `Appointment updated: ${serviceName} on ${dateStr}`;
      headline = "Your appointment has a new practitioner.";
      bodyHtml = `Your <strong>${esc(serviceName)}</strong> appointment at <strong>${esc(studioName)}</strong> on <strong>${esc(dateStr)} at ${esc(timeStr)}</strong> will now be with ${who}. The time is unchanged.`;
      bodyText = `Your ${serviceName} appointment at ${studioName} on ${dateStr} at ${timeStr} will now be with ${whoText}. The time is unchanged.`;
    } else if (kind === "moved_and_reassigned") {
      const who = practitionerName ? ` with <strong>${esc(practitionerName)}</strong>` : "";
      const whoText = practitionerName ? ` with ${practitionerName}` : "";
      subject = `Appointment updated: ${serviceName} — now ${dateStr} at ${timeStr}`;
      headline = "Your appointment time and practitioner have changed.";
      bodyHtml = `Your <strong>${esc(serviceName)}</strong> appointment at <strong>${esc(studioName)}</strong> has been moved to <strong>${esc(dateStr)} at ${esc(timeStr)}</strong>${who}.`;
      bodyText = `Your ${serviceName} appointment at ${studioName} has been moved to ${dateStr} at ${timeStr}${whoText}.`;
    } else {
      subject = `Appointment updated: ${serviceName} — now ${dateStr} at ${timeStr}`;
      headline = "Your appointment time has changed.";
      bodyHtml = `Your <strong>${esc(serviceName)}</strong> appointment at <strong>${esc(studioName)}</strong> has been moved to <strong>${esc(dateStr)} at ${esc(timeStr)}</strong>. Everything else stays the same.`;
      bodyText = `Your ${serviceName} appointment at ${studioName} has been moved to ${dateStr} at ${timeStr}. Everything else stays the same.`;
    }

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#FAFAF7;color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7;padding:40px 20px;"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="padding-bottom:24px;font-family:Georgia,serif;font-weight:700;font-size:18px;">Hone</td></tr>
      <tr><td style="padding-bottom:16px;font-family:Georgia,serif;font-weight:700;font-size:28px;line-height:1.15;">${esc(headline)}</td></tr>
      <tr><td style="padding-bottom:20px;font-family:-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.6;">Hi ${esc(clientName)},</td></tr>
      <tr><td style="padding-bottom:24px;font-family:-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.6;">
        ${bodyHtml}</td></tr>
      <tr><td style="padding-bottom:16px;font-family:-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.6;">
        Need to make a change? <a href="${esc(rescheduleUrl)}">Reschedule</a> or <a href="${esc(manageUrl)}">manage your appointment</a>.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
    const text = `Hi ${clientName},\n\n${bodyText}\n\nManage or reschedule: ${manageUrl}\n`;

    const res = await sendEmailSafely({ to: email, subject, html, text });
    if (res.ok) return "sent";
    // Provider failure → degraded + a safe category signal (never the raw provider error).
    await safeMoveAlert(input.studioId, input.appointmentId, res.retryable ? "provider_retryable" : "provider_permanent");
    return "degraded";
  } catch (e) {
    await safeMoveAlert(input.studioId, input.appointmentId, e instanceof Error ? e.name : "unknown");
    return "degraded";
  }
}

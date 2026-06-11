import "server-only";
import { resend, FROM_ADDRESS } from "@/lib/email/client";

// ===========================================================================
// notifyCriticalOpsAlert (PR #193)
// ===========================================================================
//
// Standalone operator email for CRITICAL ops alerts only. This is the
// "future PR" the PR #153 design reserved OPS_ALERT_EMAILS for.
//
// Dependency-cycle posture: this module imports ONLY the bare Resend
// client (lib/email/client.ts, which imports nothing from Hone) and
// is imported ONLY by lib/ops/alerts.ts. It never imports
// lib/email/send-appointment.ts (the appointment email subsystem that
// recordOpsAlert observes), and it NEVER calls recordOpsAlert: a
// failure here logs to stderr and stops, so alert email failures can
// not recurse into more alerts.
//
// Contract:
//   * NEVER throws. The durable ops_alerts row is the source of
//     truth; this email is best-effort notification on top.
//   * Sends only when OPS_ALERT_EMAILS is configured (comma-
//     separated). Missing/empty env logs a once-per-instance warning
//     and returns; the caller's DB write is unaffected.
//   * Content carries only what the alert row already carries (the
//     caller passes the ALREADY-REDACTED message + safe ids): no
//     secrets, no card data, no clinical content, no raw payloads.

export type CriticalAlertEmailInput = {
  event: string;
  message: string;
  createdAtIso: string;
  studioId?: string | null;
  appointmentId?: string | null;
  clientId?: string | null;
  stripeEventId?: string | null;
  stripePaymentIntentId?: string | null;
  route?: string | null;
};

const ADMIN_ALERTS_URL = "https://hone.care/admin/ops-alerts";

let missingEnvWarned = false;

function parseOpsAlertEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function environmentLabel(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
}

export async function notifyCriticalOpsAlert(
  input: CriticalAlertEmailInput,
): Promise<void> {
  try {
    const recipients = parseOpsAlertEmails(process.env.OPS_ALERT_EMAILS);
    if (recipients.length === 0) {
      if (!missingEnvWarned) {
        missingEnvWarned = true;
        console.warn(
          JSON.stringify({
            event: "ops_alert_email_disabled_env_missing",
            environment: environmentLabel(),
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return;
    }
    if (!resend) {
      console.warn(
        JSON.stringify({
          event: "ops_alert_email_disabled_no_resend_key",
          environment: environmentLabel(),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    const idLines = [
      input.studioId ? `Studio: ${input.studioId}` : null,
      input.appointmentId ? `Appointment: ${input.appointmentId}` : null,
      input.clientId ? `Client id: ${input.clientId}` : null,
      input.stripeEventId ? `Stripe event: ${input.stripeEventId}` : null,
      input.stripePaymentIntentId
        ? `PaymentIntent: ${input.stripePaymentIntentId}`
        : null,
      input.route ? `Route: ${input.route}` : null,
    ].filter((l): l is string => l !== null);

    const text = [
      `CRITICAL ops alert: ${input.event}`,
      "",
      input.message,
      "",
      `Created: ${input.createdAtIso}`,
      `Environment: ${environmentLabel()}`,
      ...idLines,
      "",
      `Review and resolve: ${ADMIN_ALERTS_URL}`,
    ].join("\n");

    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: recipients,
      subject: `[Hone CRITICAL] ${input.event}`,
      text,
    });
    if (error) {
      console.error(
        JSON.stringify({
          event: "ops_alert_email_send_failed",
          origin_event: input.event,
          err_message: String(error.message ?? error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  } catch (err) {
    // Last resort: log and stop. Never throw, never recurse into
    // recordOpsAlert.
    console.error(
      JSON.stringify({
        event: "ops_alert_email_threw",
        origin_event: input.event,
        err_message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

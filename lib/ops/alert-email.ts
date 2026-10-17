import "server-only";
import { resend, FROM_ADDRESS } from "@/lib/email/client";
import { SAFE_STRIPE_ID_PREFIXES } from "@/lib/ops/redact";

// ===========================================================================
// notifyCriticalOpsAlert (PR #193)
// ===========================================================================
//
// Standalone operator email for CRITICAL ops alerts only. This is the
// "future PR" the PR #153 design reserved OPS_ALERT_EMAILS for.
//
// Dependency-cycle posture: this module imports ONLY the bare Resend
// client (lib/email/client.ts, which imports nothing from Hone) and the
// pure, dependency-free lib/ops/redact.ts, and is imported ONLY by lib/ops/alerts.ts. It never imports
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
//   * Content carries only the event slug, the ALREADY-REDACTED message
//     (with any record UUID or Stripe object id replaced), the time, the
//     environment and the admin link: no record ids (#828 G-24), no
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

// #828 G-24: the email leaves Hone through Resend, which cannot sign a BAA,
// so it carries NO record identifiers. The studio, appointment and client
// UUIDs, Stripe object ids and the route stay on the durable ops_alerts row
// and the /admin/ops-alerts page. The (already PII-redacted) message is
// scrubbed of any UUID or Stripe object id it embeds; the event slug stays in
// the subject because it names a failure class, not a record. The UUID
// pattern has no boundary (an id glued to letters is still removed, Codex P1
// 4301586679 on #903) and accepts a %2D-encoded hyphen.
const RECORD_ID_RE = new RegExp(
  // A hex digit may itself be percent-encoded (%30-%39, %41-%46, %61-%66):
  // URL serialization keeps the escape, and routing decodes it straight back
  // to the id (Codex P2 4301707490). Same for the hyphen (%2D).
  ["{8}", "{4}", "{4}", "{4}", "{12}"]
    .map((n) => `(?:[0-9a-f]|%3[0-9]|%4[1-6]|%6[1-6])${n}`)
    .join("(?:-|%2d)"),
  "gi",
);
// Every Stripe prefix lib/ops/redact.ts preserves as a "safe" id, plus pm_
// (PaymentMethod), which redact.ts does not list. NO leading boundary (Codex
// P1 4301636814): an id glued to preceding text ("refpi_3...", "refund_re_...")
// is still removed. That can over-redact an ordinary word ending in a prefix
// ("api_..." loses its "pi_..." tail); in an email that only points at the
// alert, over-redaction is the safe side.
const STRIPE_ID_RE = new RegExp(
  `(?:${[...new Set([...SAFE_STRIPE_ID_PREFIXES, "pm"])].join("|")})_[A-Za-z0-9]{6,}`,
  "g",
);
// ANY Stripe-shaped object id, whatever its prefix (Codex P1 4301706583:
// dp_, src_, card_, ... are outside the list above). Stripe ids are a short
// lowercase prefix, "_", then a long run that mixes digits and letters. Event
// slugs and ordinary snake_case words carry no digit after the "_", so they
// are left alone.
const GENERIC_STRIPE_ID_RE = /[a-z]{2,12}_(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{10,}/g;

function withoutRecordIds(text: string): string {
  return text
    .replace(RECORD_ID_RE, "[id]")
    .replace(STRIPE_ID_RE, "[stripe-id]")
    .replace(GENERIC_STRIPE_ID_RE, "[stripe-id]");
}

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

    // No id lines (#828 G-24): studioId, appointmentId, clientId, the Stripe
    // ids and the route are deliberately NOT rendered. They remain on the
    // ops_alerts row, which the link below opens.
    const text = [
      `CRITICAL ops alert: ${input.event}`,
      "",
      withoutRecordIds(input.message),
      "",
      `Created: ${input.createdAtIso}`,
      `Environment: ${environmentLabel()}`,
      "",
      "Record and payment details are on the alert itself, not in this email.",
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

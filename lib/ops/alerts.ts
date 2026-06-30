import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { notifyCriticalOpsAlert } from "@/lib/ops/alert-email";
import {
  redactOpsAlertMessage,
  redactOpsAlertDetails,
} from "@/lib/ops/redact";

// ===========================================================================
// recordOpsAlert (PR #153)
// ===========================================================================
//
// Single entry point for recording operator-facing alerts about silent
// failure states in Hone's async paths. The helper:
//
//   * NEVER throws to the caller. Failure of the helper itself MUST NOT
//     bring down the business flow that called it. Every internal step
//     is try/catch'd; a structured stderr log is the last-resort
//     fallback.
//   * Always emits a structured `console.error` JSON line tagged with
//     the alert event name + safe identifiers. This is the floor:
//     Vercel logs always carry the event even if the DB insert fails.
//   * Inserts a durable row into `public.ops_alerts` via the service-
//     role admin client. RLS lets studio members read alerts scoped
//     to their studio (migration 0067).
//
// What this helper does NOT do
// ----------------------------
// * No appointment-email-subsystem coupling. PR #193 added operator
//   email for CRITICAL alerts via the standalone
//   lib/ops/alert-email.ts (bare Resend client; reads
//   OPS_ALERT_EMAILS; never calls back into recordOpsAlert), so the
//   PR #153 cycle concern (ops alerts <- appointment email helper ->
//   ops alerts) stays structurally impossible: this module still
//   never imports lib/email/send-appointment.ts.
// * No retry. A failure to insert is logged and dropped.
// * No SMS. SMS alerts are out of scope for this PR.
// * No payment-moving code. The helper imports nothing from
//   `lib/stripe/*` or the payment executor (lib/billing/session-payment-charge.ts).
// * No raw token / client_secret / card / CVC / API-key storage.
//   The redactor below strips known dangerous keys and values
//   defensively even if a caller forgot.

export type AlertSeverity = "info" | "warning" | "critical";

export type OpsAlertInput = {
  severity: AlertSeverity;
  // Short kebab/underscore identifier; e.g. "manual_fee_needs_manual_review".
  // The full set of well-known event names is documented in
  // docs/11_RUNBOOK.md. New events are allowed; reviewer ensures the
  // name is meaningful + future-greppable.
  event: string;
  // One-line human-readable summary. Safe to include in operator
  // notifications. Length capped at 2000 by the DB CHECK; the helper
  // truncates here so a caller's overflow does not surface as a
  // server-side insert failure.
  message: string;
  studioId?: string | null;
  appointmentId?: string | null;
  clientId?: string | null;
  stripeEventId?: string | null;
  stripePaymentIntentId?: string | null;
  manualFeeAttemptId?: string | null;
  route?: string | null;
  // Free-form sanitized context. Run through the redactor below
  // before the DB insert / structured log. Callers should NEVER put
  // raw tokens / client_secret / card data / CVC / secret keys /
  // raw Stripe payloads here. The redactor is belt-and-braces.
  safeDetails?: Record<string, unknown>;
};

const MAX_MESSAGE_LEN = 2000;

// PR #285: central redaction. The pure, dependency-free helpers live in
// lib/ops/redact.ts so they are trivially testable and reusable. The
// message scrubber (redactOpsAlertMessage) is the PR #285 fix — the raw
// `message` was previously only truncated, so a provider error.message
// could leak PII / signed URLs / tokens / Stripe secrets into the log,
// the ops_alerts row, the admin page, and the critical email. safeDetails
// redaction is unchanged in spirit (credential-named keys + secret-shaped
// values) and now also scrubs embedded patterns in string values.
// redactSafeDetails is kept as the public name the existing tests use.
export const redactSafeDetails = redactOpsAlertDetails;

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 14) + "...[truncated]";
}

function structuredConsoleLog(payload: Record<string, unknown>): void {
  try {
    console.error(JSON.stringify(payload));
  } catch {
    // Last-resort fallback if JSON.stringify itself throws (cyclic
    // structure). We never let the alerting helper escalate.
    console.error("ops_alert_serialize_failed", payload.event ?? "unknown");
  }
}

// Operator email dispatch lives in lib/ops/alert-email.ts (PR #193):
// critical-severity only, bare Resend client, no path back into the
// appointment-email helper, never calls recordOpsAlert. This module
// invokes it after the durable write attempt.

// Main entry point.
export async function recordOpsAlert(input: OpsAlertInput): Promise<void> {
  // Sanitize first so the structured log uses the redacted detail
  // shape too. The redactor never throws.
  const redacted = redactSafeDetails(input.safeDetails);
  // PR #285: redact the message CENTRALLY before it reaches ANY sink
  // (console log, ops_alerts row, admin page, critical email). The single
  // `message` local below is the only message surface, so this one call
  // makes every caller's message safe-by-default — no per-call-site fix
  // is required for correctness.
  const message = truncate(
    redactOpsAlertMessage(input.message),
    MAX_MESSAGE_LEN,
  );

  // Structured stderr log first. Always emitted, even if DB insert
  // fails. This is the floor for Vercel-log-only debugging.
  structuredConsoleLog({
    event: input.event,
    ops_alert: true,
    severity: input.severity,
    message,
    studio_id: input.studioId ?? null,
    appointment_id: input.appointmentId ?? null,
    client_id: input.clientId ?? null,
    stripe_event_id: input.stripeEventId ?? null,
    stripe_payment_intent_id: input.stripePaymentIntentId ?? null,
    manual_fee_attempt_id: input.manualFeeAttemptId ?? null,
    route: input.route ?? null,
    safe_details: redacted,
    timestamp: new Date().toISOString(),
  });

  // Durable row insert. Service-role admin client only.
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("ops_alerts").insert({
      severity: input.severity,
      event: input.event,
      message,
      studio_id: input.studioId ?? null,
      appointment_id: input.appointmentId ?? null,
      client_id: input.clientId ?? null,
      stripe_event_id: input.stripeEventId ?? null,
      stripe_payment_intent_id: input.stripePaymentIntentId ?? null,
      manual_fee_attempt_id: input.manualFeeAttemptId ?? null,
      route: input.route ?? null,
      safe_details: redacted,
    });
    if (error) {
      structuredConsoleLog({
        event: "ops_alert_insert_failed",
        origin_event: input.event,
        code: error.code,
        err_message: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    structuredConsoleLog({
      event: "ops_alert_insert_threw",
      origin_event: input.event,
      err_message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    });
  }

  // PR #193: operator email for CRITICAL alerts only, AFTER the
  // durable write attempt so an email failure can never block or
  // lose the row. Dispatched via the standalone
  // lib/ops/alert-email.ts (bare Resend client; no path into
  // lib/email/send-appointment.ts; never calls recordOpsAlert, so
  // alert-email failures cannot recurse). Warnings/info stay
  // row+log only. notifyCriticalOpsAlert never throws; the
  // try/catch is belt-and-braces.
  if (input.severity === "critical") {
    try {
      await notifyCriticalOpsAlert({
        event: input.event,
        message,
        createdAtIso: new Date().toISOString(),
        studioId: input.studioId ?? null,
        appointmentId: input.appointmentId ?? null,
        clientId: input.clientId ?? null,
        stripeEventId: input.stripeEventId ?? null,
        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
        route: input.route ?? null,
      });
    } catch (err) {
      structuredConsoleLog({
        event: "ops_alert_email_dispatch_threw",
        origin_event: input.event,
        err_message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  }
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";

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
//   * Optionally emails an `OPS_ALERT_EMAILS` allowlist for critical
//     alerts. Gated behind the env var (fail-closed when unset).
//     NEVER emails for `email_*` events; that would create a loop.
//
// What this helper does NOT do
// ----------------------------
// * No retry. A failure to insert / email is logged and dropped.
// * No SMS. SMS alerts are out of scope for this PR.
// * No payment-moving code. The helper imports nothing from
//   `lib/stripe/*` or `lib/billing/manual-fee-charge.ts`.
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

// Keys that may contain credential-shaped values. Redacted from
// safeDetails before insert or log. Case-insensitive.
const REDACT_KEYS = [
  "token",
  "raw_token",
  "rawtoken",
  "client_secret",
  "clientsecret",
  "secret",
  "password",
  "cookie",
  "set-cookie",
  "authorization",
  "auth",
  "api_key",
  "apikey",
  "stripe_secret_key",
  "private_key",
  "card_number",
  "cardnumber",
  "pan",
  "cvc",
  "cvv",
  "ssn",
  "bearer",
];

const REDACTED = "[redacted]";
const MAX_MESSAGE_LEN = 2000;
const MAX_DETAIL_VALUE_LEN = 500;

function looksLikeStripeSecret(value: string): boolean {
  return /^sk_(live|test)_/.test(value);
}
function looksLikeBearerToken(value: string): boolean {
  // Long base64-url-ish strings (>= 32 chars, mostly token alphabet)
  // are likely raw tokens we should not surface. We DO NOT match
  // typical UUIDs (length 36 with hyphens) so resource IDs flow.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return false;
  }
  return /^[A-Za-z0-9_-]{32,}$/.test(value);
}
function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (
      looksLikeStripeSecret(value) ||
      looksLikeJwt(value) ||
      looksLikeBearerToken(value)
    ) {
      return REDACTED;
    }
    if (value.length > MAX_DETAIL_VALUE_LEN) {
      return value.slice(0, MAX_DETAIL_VALUE_LEN) + "...[truncated]";
    }
    return value;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (REDACT_KEYS.includes(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(val);
  }
  return out;
}

// Exported for unit tests; callers should use recordOpsAlert.
export function redactSafeDetails(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input) return {};
  return redactObject(input);
}

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

// Parse the allowlist from OPS_ALERT_EMAILS. Returns [] when unset.
// The helper's email path is gated on this returning non-empty.
function parseOpsAlertEmails(): string[] {
  const raw = process.env.OPS_ALERT_EMAILS;
  if (!raw || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Email path. Conservative: only fires for `critical` severity, only
// when OPS_ALERT_EMAILS is configured, and NEVER for events whose
// name starts with "email_" (the loop-avoidance rule). The helper
// imports the Resend client lazily so the alerts module does not
// pull a heavier email graph into routes that don't need it.
async function maybeEmailAlert(
  input: OpsAlertInput,
  redacted: Record<string, unknown>,
): Promise<void> {
  if (input.severity !== "critical") return;
  if (input.event.startsWith("email_")) return; // loop guard
  const recipients = parseOpsAlertEmails();
  if (recipients.length === 0) return;
  try {
    // Lazy import to keep the alerting module light and avoid
    // pulling lib/email/* into routes that don't ship email code.
    const { sendEmailSafely } = await import("@/lib/email/send-appointment");
    const subject = `[Hone ops] ${input.severity}: ${input.event}`;
    const linesText = [
      `Severity: ${input.severity}`,
      `Event:    ${input.event}`,
      `Message:  ${input.message}`,
      input.studioId ? `Studio:   ${input.studioId}` : null,
      input.appointmentId ? `Appt:     ${input.appointmentId}` : null,
      input.clientId ? `Client:   ${input.clientId}` : null,
      input.stripeEventId ? `StripeEv: ${input.stripeEventId}` : null,
      input.stripePaymentIntentId
        ? `StripePI: ${input.stripePaymentIntentId}`
        : null,
      input.manualFeeAttemptId
        ? `Manual fee attempt: ${input.manualFeeAttemptId}`
        : null,
      input.route ? `Route:    ${input.route}` : null,
      "",
      "Safe details:",
      JSON.stringify(redacted, null, 2),
    ].filter((l): l is string => l !== null);
    const text = linesText.join("\n");
    const html = `<pre style="font-family: monospace;">${text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`;
    for (const to of recipients) {
      await sendEmailSafely({ to, subject, html, text });
    }
  } catch (err) {
    structuredConsoleLog({
      event: "ops_alert_email_dispatch_failed",
      origin_event: input.event,
      err_message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    });
  }
}

// Main entry point.
export async function recordOpsAlert(input: OpsAlertInput): Promise<void> {
  // Sanitize first so the structured log uses the redacted detail
  // shape too. The redactor never throws.
  const redacted = redactSafeDetails(input.safeDetails);
  const message = truncate(input.message, MAX_MESSAGE_LEN);

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

  // Optional operator email. Fail-closed if env unset.
  // Awaited so test harnesses see a deterministic call sequence,
  // but the maybeEmailAlert function itself never throws.
  await maybeEmailAlert(input, redacted);
}

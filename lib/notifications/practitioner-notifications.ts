// PR #164. Practitioner notification helper. Single writer to the
// public.practitioner_notifications table (migration 0070).
//
// This module is the trust boundary between the public event sources
// (public booking, public cancel, public reschedule) and the
// practitioner-facing notification center. Public event sources are
// anonymous visitor / token-bearing flows that cannot satisfy the
// is_studio_member(studio_id) RLS predicate; they must write via
// service_role. We bypass RLS deliberately here BUT every field is
// derived server-side from already-committed rows; no part of the
// notification payload comes from visitor input. That is enforced
// by the type shape on the call site (no free-text from formData
// reaches this helper) and by the event_type allowlist below.
//
// HARD CONTRACT: this helper is never-throws from the caller's
// perspective. The pattern mirrors lib/sms/send-appointment.ts:
// logSmsFailure (PR #153 / #155) -- the entire body runs inside a
// fire-and-forget IIFE wrapped in `void`. The caller awaits NOTHING.
// A failure here MUST NOT roll back the booking, cancellation, or
// reschedule that just succeeded. Failures are logged via the
// existing recordOpsAlert helper (PR #153) so the operator sees the
// silent failure trail without it leaking back to the visitor.
//
// HARD BOUNDARY: this module imports "server-only" so a future
// "use client" file that accidentally imports it fails at build
// time. The PR #155 admin-server boundary test
// (tests/lib/supabase/admin-server-boundary.test.ts) walks
// app/ + lib/ + components/ for "use client" + admin-server
// imports; this helper passes the same gate because it does not
// import admin-server in a client tree.

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type { PractitionerNotificationEventType } from "@/lib/types/database";

// v1 event allowlist. The DB does not carry a CHECK constraint so
// the helper is the single authority on what event types may land
// in the table. Adding a new event type later is a one-line edit
// here; the migration does not need to change.
const ALLOWED_EVENT_TYPES: ReadonlySet<PractitionerNotificationEventType> =
  new Set(["new_booking", "appointment_cancelled", "appointment_rescheduled"]);

export type RecordPractitionerNotificationInput = {
  studioId: string;
  // Nullable so the helper accepts notifications for appointments
  // whose practitioner_id was null at insert time. Studio-wide
  // visibility in v1 means a null practitioner_id still surfaces
  // the row on every studio member's notification list.
  practitionerId: string | null;
  eventType: PractitionerNotificationEventType;
  // Practitioner-facing display strings. The CALLER is responsible
  // for keeping these free of secrets, tokens, Stripe ids, full
  // emails, phone numbers, or any other PII beyond what the
  // appointment detail page already shows. The body MUST be safe to
  // surface on the notification list UI.
  title: string;
  body: string | null;
  appointmentId: string | null;
  clientId: string | null;
  // In-app deep link the notification row links to (e.g.
  // /calendar/<appointment_id>). Composed server-side; no part of
  // it should come from visitor input.
  href: string | null;
};

// Fire-and-forget recorder. The caller MUST NOT await the returned
// promise; the function returns void on purpose. Two layers of
// safety: (1) the IIFE's outer try/catch swallows everything; (2)
// even the recordOpsAlert fallback never throws (PR #153). A
// failure at any point of the helper logs to stderr via console
// (sanitised) and to ops_alerts when the alert path itself is
// reachable. Net effect: a booking / cancel / reschedule cannot
// fail because the notification insert failed.
export function recordPractitionerNotification(
  input: RecordPractitionerNotificationInput,
): void {
  // Validate the event type synchronously so a misuse at the call
  // site (e.g. a typo in eventType) is logged with the actual call
  // origin and does not silently disappear. We still do not throw;
  // the caller has already committed the user-visible mutation.
  if (!ALLOWED_EVENT_TYPES.has(input.eventType)) {
    logSilently({
      event: "practitioner_notification_invalid_event_type",
      input_event_type: input.eventType,
      studio_id: input.studioId,
    });
    fireAndForgetOpsAlert({
      severity: "warning",
      event: "practitioner_notification_invalid_event_type",
      message:
        "recordPractitionerNotification called with an unknown event type. The notification was not written.",
      studioId: input.studioId,
      appointmentId: input.appointmentId,
      safeDetails: { input_event_type: input.eventType },
    });
    return;
  }
  // Same shape as PR #155 logSmsFailure: wrap the entire async body
  // in a void IIFE so the caller's await chain is not extended and
  // any throw from the admin client or the insert itself is
  // contained.
  void (async () => {
    try {
      const admin = createAdminClient();
      const { error } = await admin
        .from("practitioner_notifications")
        .insert({
          studio_id: input.studioId,
          practitioner_id: input.practitionerId,
          event_type: input.eventType,
          title: input.title,
          body: input.body,
          appointment_id: input.appointmentId,
          client_id: input.clientId,
          href: input.href,
        });
      if (error) {
        logSilently({
          event: "practitioner_notification_insert_failed",
          code: error.code,
          err_message: error.message,
          event_type: input.eventType,
          studio_id: input.studioId,
          appointment_id: input.appointmentId,
        });
        fireAndForgetOpsAlert({
          severity: "warning",
          event: "practitioner_notification_insert_failed",
          message: `Practitioner notification insert failed for ${input.eventType}. The core mutation already committed.`,
          studioId: input.studioId,
          appointmentId: input.appointmentId,
          safeDetails: {
            event_type: input.eventType,
            code: error.code ?? null,
          },
        });
      }
    } catch (err) {
      // createAdminClient throws synchronously when SUPABASE_SERVICE
      // _ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL are missing; the insert
      // call itself can throw on a network failure. Either way the
      // caller's mutation already committed; we only log.
      logSilently({
        event: "practitioner_notification_insert_threw",
        err_message: err instanceof Error ? err.message : String(err),
        event_type: input.eventType,
        studio_id: input.studioId,
        appointment_id: input.appointmentId,
      });
      fireAndForgetOpsAlert({
        severity: "warning",
        event: "practitioner_notification_insert_threw",
        message: `Practitioner notification helper threw for ${input.eventType}. The core mutation already committed.`,
        studioId: input.studioId,
        appointmentId: input.appointmentId,
        safeDetails: {
          event_type: input.eventType,
          err_message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  })();
}

// Local console-log helper. Keeps the stderr line shape compatible
// with the structured-log scraping the operator already uses for
// ops_alerts (see lib/ops/alerts.ts:structuredConsoleLog). We log
// even when the ops_alerts insert path is also taken so the
// operator can correlate without DB access.
function logSilently(payload: Record<string, unknown>): void {
  try {
    console.error(
      JSON.stringify({
        ...payload,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    // best-effort
  }
}

// Fire-and-forget ops_alerts write. recordOpsAlert (PR #153) is
// itself never-throws; the dynamic import + outer try/catch are
// belt-and-braces for the case where the module fails to load
// (e.g. circular dep in a future refactor).
type OpsAlertInput = {
  // Mirrors lib/ops/alerts.ts:AlertSeverity. We use "warning" only
  // in this module (a notification miss is not a system outage).
  severity: "info" | "warning" | "critical";
  event: string;
  message: string;
  studioId: string | null;
  appointmentId: string | null;
  safeDetails: Record<string, unknown>;
};
function fireAndForgetOpsAlert(input: OpsAlertInput): void {
  void (async () => {
    try {
      const { recordOpsAlert } = await import("@/lib/ops/alerts");
      await recordOpsAlert({
        severity: input.severity,
        event: input.event,
        message: input.message,
        studioId: input.studioId,
        appointmentId: input.appointmentId,
        route: "lib/notifications/practitioner-notifications",
        safeDetails: input.safeDetails,
      });
    } catch {
      // recordOpsAlert never throws; this catch is unreachable.
    }
  })();
}

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { todayInTz } from "@/lib/booking/tz";
import {
  resolveAuthoritativeSessionPaymentAmount,
  type SessionPaymentAmountResult,
} from "@/lib/billing/session-payment-amount";

// THE server-side loader for a session payment's authoritative amount.
//
// F-PAY-001. Every surface that shows or prepares a session payment goes
// through here, so the price is decided in ONE place from CURRENT records:
// the session-detail card, the quick-checkout modal, and (crucially) the
// prepare action itself, which re-loads independently rather than trusting
// anything the page rendered earlier or the browser sent back.
//
// LINEAGE IS ENFORCED HERE, not assumed:
//   * the session must be live (not soft-deleted) and in THIS studio;
//   * the appointment comes from sessions.appointment_id, never recovered by
//     client id, because a client can have several appointments and pricing the
//     wrong one would charge the wrong amount;
//   * the appointment must belong to the same studio AND the session's client;
//   * the booked service must belong to the same studio.
// Any break returns an unresolved result; nothing falls back across a tenant.
//
// The pure resolver is called exactly once, at the end, with trusted inputs.

export type AuthoritativeAmountContext = {
  result: SessionPaymentAmountResult;
  // Echoed back for display; never an input to the decision.
  appointmentId: string | null;
};

// Reasons the CONTEXT itself could not be established, distinct from the
// pricing outcomes the pure resolver owns.
export type AuthoritativeAmountLoadFailure =
  | { kind: "session_not_found" }
  | { kind: "no_linked_appointment" }
  | { kind: "appointment_lineage_mismatch" }
  // Review 3777890267. A database READ FAILURE is not an empty result.
  //
  // Every read below used to destructure `data` only, so a failed query was
  // indistinguishable from "no rows". For client_pricing that was money-moving
  // and fail-OPEN: a client with two conflicting current custom prices should
  // resolve to `ambiguous_custom_pricing` and BLOCK, but if that SELECT failed,
  // `pricingRows ?? []` became an empty pricing set, the resolver fell back to
  // the positive menu price, and the result was a confident `resolved` that
  // authorized charging a stale prepared attempt.
  //
  // `stage` is for logs and tests only; it never reaches the practitioner and
  // never carries a Postgres/PostgREST payload.
  | {
      kind: "read_failed";
      stage: "session" | "appointment" | "client_pricing";
    };

export type AuthoritativeAmountLoad =
  | ({ ok: true } & AuthoritativeAmountContext)
  | { ok: false; failure: AuthoritativeAmountLoadFailure };

export async function getAuthoritativeSessionPaymentAmount(args: {
  studioId: string;
  sessionId: string;
  studioTimezone: string;
}): Promise<AuthoritativeAmountLoad> {
  const supabase = await createClient();

  // 1. The session, scoped to the studio and required to be live.
  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("id, client_id, appointment_id, deleted_at")
    .eq("id", args.sessionId)
    .eq("studio_id", args.studioId)
    .is("deleted_at", null)
    .maybeSingle();
  if (sessionError) {
    return { ok: false, failure: { kind: "read_failed", stage: "session" } };
  }
  if (!sessionRow) return { ok: false, failure: { kind: "session_not_found" } };

  const appointmentId = (sessionRow.appointment_id as string | null) ?? null;
  if (!appointmentId) {
    return { ok: false, failure: { kind: "no_linked_appointment" } };
  }

  // 2. The appointment, by sessions.appointment_id, with FULL lineage in the
  //    predicate: same studio AND the session's own client. A mismatch yields
  //    no row rather than a price for somebody else's booking.
  const { data: apptRow, error: apptError } = await supabase
    .from("appointments")
    // BARE-TABLE embed WITHOUT selecting the service's studio_id. Migration
    // 0151 replaced the single-column appointments.service_id FK with a
    // composite (service_id, studio_id) FK; asking for studio_id inside the
    // embed makes PostgREST fail to resolve the relationship and return a NULL
    // service, which this loader would then read as "no booked service" and
    // block every payment. Same class of trap 0094/0151 caused before.
    .select("id, duration_minutes, service:services(name, price_cents)")
    .eq("id", appointmentId)
    .eq("studio_id", args.studioId)
    .eq("client_id", sessionRow.client_id as string)
    .maybeSingle();
  if (apptError) {
    return { ok: false, failure: { kind: "read_failed", stage: "appointment" } };
  }
  if (!apptRow) {
    return { ok: false, failure: { kind: "appointment_lineage_mismatch" } };
  }

  // Supabase nests an embed as an array or an object depending on the driver
  // build; normalise defensively.
  const embed = (apptRow as { service?: unknown }).service;
  const svc = (Array.isArray(embed) ? embed[0] : embed) as
    | { name?: string | null; price_cents?: number | null }
    | null;

  // 3. Service-studio lineage. It is enforced at the DATABASE level and more
  //    strongly than an app-level equality check could: migration 0151's
  //    composite (service_id, studio_id) FK means an appointment in THIS studio
  //    can only reference a service in the same studio. The appointment row is
  //    already studio-scoped above, so a cross-studio service is unreachable.
  const serviceInput =
    svc && svc.name ? { name: svc.name, price_cents: svc.price_cents ?? null } : null;

  // 4. Current client-specific pricing for this client, studio-scoped.
  const { data: pricingRows, error: pricingError } = await supabase
    .from("client_pricing")
    .select("service_name, price_cents, notes, effective_from")
    .eq("studio_id", args.studioId)
    .eq("client_id", sessionRow.client_id as string);
  // The resolver must never be called with a pricing set we are not sure is
  // complete. Zero rows is a valid answer (no custom pricing); a failed read
  // is not an answer at all.
  if (pricingError) {
    return {
      ok: false,
      failure: { kind: "read_failed", stage: "client_pricing" },
    };
  }

  // 5. ONE call into the pure resolver, with the studio-local date injected.
  const result = resolveAuthoritativeSessionPaymentAmount({
    service: serviceInput,
    appointmentDurationMinutes:
      (apptRow as { duration_minutes?: number | null }).duration_minutes ?? null,
    customPricing: (pricingRows ?? []) as Array<{
      service_name: string;
      price_cents: number;
      notes: string | null;
      effective_from: string;
    }>,
    today: todayInTz(args.studioTimezone),
  });

  return { ok: true, result, appointmentId };
}

// Practitioner-facing copy for a context that could not be established. Kept
// beside the states so copy and branch cannot drift, and deliberately vague
// about internals: a mismatch is not something to explain in detail.
export function loadFailureMessage(f: AuthoritativeAmountLoadFailure): string {
  switch (f.kind) {
    case "session_not_found":
      return "This session is not available for payment.";
    case "no_linked_appointment":
      return "This session is not linked to a booked appointment, so there is no service price to charge.";
    case "appointment_lineage_mismatch":
      return "This session's appointment could not be verified. Refresh and try again.";
    case "read_failed":
      // Deliberately generic and identical for every stage: the practitioner
      // needs to know it is unconfirmed and retryable, not which query failed.
      return "The current payment amount could not be confirmed. Refresh and try again.";
  }
}

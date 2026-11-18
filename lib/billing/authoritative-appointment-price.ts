import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { todayInTz } from "@/lib/booking/tz";
import {
  resolveAuthoritativeSessionPaymentAmount,
  type SessionPaymentAmountResult,
} from "@/lib/billing/session-payment-amount";

// The appointment-keyed sibling of lib/billing/authoritative-session-payment.ts, for a fee on a cancelled or no-show
// appointment (which has no session). It calls the SAME pure resolver; it adds no second pricing rule.
//
// The caller passes the service-role client and has already proven the viewer is the studio owner. Scope: the
// appointment is read with studio_id in the predicate, the client is taken from that appointment row (never an argument),
// and client_pricing is read for that same (studio, client).
//
// CUSTOM-PRICING DATE. `today` is the current date in the studio's timezone, exactly as the session path uses. A
// cancelled appointment's own date may be earlier or later than today; this is a stated definition, and a question
// for the platform operator and the studio, in the PR body.

export type AppointmentPriceLoad =
  | { ok: true; result: SessionPaymentAmountResult }
  | { ok: false; reason: "appointment_not_found" | "read_failed" };

export async function loadAppointmentSessionPrice(args: {
  admin: SupabaseClient;
  studioId: string;
  appointmentId: string;
  studioTimezone: string;
}): Promise<AppointmentPriceLoad> {
  const { admin } = args;
  const { data: apptRow, error: apptError } = await admin
    .from("appointments")
    // BARE-TABLE embed WITHOUT the service's studio_id: migration 0151's composite (service_id, studio_id) FK makes a
    // studio_id inside the embed resolve to a NULL service. Copied from authoritative-session-payment.ts.
    .select("id, client_id, duration_minutes, service:services(name, price_cents)")
    .eq("id", args.appointmentId)
    .eq("studio_id", args.studioId)
    .maybeSingle();
  if (apptError) return { ok: false, reason: "read_failed" };
  if (!apptRow) return { ok: false, reason: "appointment_not_found" };

  const embed = (apptRow as { service?: unknown }).service;
  const svc = (Array.isArray(embed) ? embed[0] : embed) as
    | { name?: string | null; price_cents?: number | null }
    | null;
  const serviceInput = svc && svc.name ? { name: svc.name, price_cents: svc.price_cents ?? null } : null;

  const { data: pricingRows, error: pricingError } = await admin
    .from("client_pricing")
    .select("service_name, price_cents, notes, effective_from")
    .eq("studio_id", args.studioId)
    .eq("client_id", (apptRow as { client_id: string }).client_id);
  // A failed read is not "no custom pricing": never call the resolver with a pricing set that may be incomplete.
  if (pricingError) return { ok: false, reason: "read_failed" };

  const result = resolveAuthoritativeSessionPaymentAmount({
    service: serviceInput,
    appointmentDurationMinutes: (apptRow as { duration_minutes?: number | null }).duration_minutes ?? null,
    customPricing: (pricingRows ?? []) as Array<{
      service_name: string;
      price_cents: number;
      notes: string | null;
      effective_from: string;
    }>,
    today: todayInTz(args.studioTimezone),
  });
  return { ok: true, result };
}

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { todayInTz } from "@/lib/booking/tz";
import { getSessionPaymentEligibility } from "@/lib/billing/session-payment-eligibility";
import {
  resolveSessionPaymentDefault,
  type SessionPaymentDefaultAmount,
} from "@/lib/billing/session-payment-default-amount";
import type { SessionPaymentEligibility } from "@/lib/billing/session-payment-types";

// Quick checkout (Chloe feedback: checkout takes too many clicks while the client
// is waiting). This resolver is the ONLY new server logic — it turns an
// APPOINTMENT into the exact same eligibility + default-amount inputs the session
// detail page already computes, so the quick-checkout modal can render the
// existing SessionPaymentPrepareCard and drive the existing prepare/execute/
// receipt/refund server actions UNCHANGED. It never charges, never writes, and
// never touches clinical state.
//
// The whole payment path is SESSION-scoped (a charge attaches to a session linked
// to a completed appointment). So checkout requires a session; if none exists the
// resolver returns an ineligible result pointing the practitioner at the existing
// charting workflow (it never invents a hidden clinical session).

export type QuickCheckoutContext =
  | {
      ok: true;
      sessionId: string;
      clientId: string;
      clientName: string;
      appointment: {
        id: string;
        status: string | null;
        startsAt: string | null;
        serviceName: string | null;
      };
      eligibility: SessionPaymentEligibility;
      defaultAmount: SessionPaymentDefaultAmount | null;
    }
  | {
      ok: false;
      // A safe, practitioner-facing reason. clientId is included when known so
      // the modal can link to the existing charting workflow.
      reason: string;
      clientId: string | null;
    };

type Args = {
  studioId: string;
  studioTimezone: string;
  appointmentId: string;
};

export async function resolveQuickCheckoutContext(
  args: Args,
): Promise<QuickCheckoutContext> {
  const supabase = await createClient();

  // 1) Appointment, studio-scoped (RLS + explicit .eq). No client-supplied
  //    studio/amount/status is trusted; everything is read from the row.
  const { data: appt } = await supabase
    .from("appointments")
    .select(
      "id, studio_id, status, starts_at, duration_minutes, client_id, service_id, client:clients(name), service:services(name, price_cents)",
    )
    .eq("studio_id", args.studioId)
    .eq("id", args.appointmentId)
    .maybeSingle();

  if (!appt) {
    return { ok: false, reason: "Appointment not found in this studio.", clientId: null };
  }

  const clientId = (appt.client_id as string | null) ?? null;
  const clientEmbed = (appt as { client?: unknown }).client;
  const clientObj = (Array.isArray(clientEmbed) ? clientEmbed[0] : clientEmbed) as
    | { name?: string | null }
    | null;
  const clientName = clientObj?.name?.trim() || "Client";
  const svcEmbed = (appt as { service?: unknown }).service;
  const svcObj = (Array.isArray(svcEmbed) ? svcEmbed[0] : svcEmbed) as
    | { name?: string | null; price_cents?: number | null }
    | null;

  // 2) The treatment session for this appointment. Payment is session-scoped;
  //    if there is no session yet, send the practitioner to charting first.
  const { data: sessionRow } = await supabase
    .from("sessions")
    .select("id")
    .eq("studio_id", args.studioId)
    .eq("appointment_id", args.appointmentId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (!sessionRow) {
    return {
      ok: false,
      reason:
        "No treatment session for this appointment yet. Open the client's session to start charting, then check out.",
      clientId,
    };
  }
  const sessionId = sessionRow.id as string;

  // 3) Reuse the EXACT eligibility + default-amount helpers the session page uses
  //    (unchanged). Eligibility carries the blocking reasons (not completed, no
  //    card, already-active-attempt, etc.) the card renders.
  const eligibility = await getSessionPaymentEligibility({
    studioId: args.studioId,
    sessionId,
  });

  let defaultAmount: SessionPaymentDefaultAmount | null = null;
  if (svcObj?.name) {
    const { data: pricingRows } = await supabase
      .from("client_pricing")
      .select("service_name, price_cents, notes, effective_from")
      .eq("studio_id", args.studioId)
      .eq("client_id", clientId ?? "");
    defaultAmount = resolveSessionPaymentDefault({
      service: { name: svcObj.name, price_cents: svcObj.price_cents ?? null },
      appointmentDurationMinutes:
        (appt.duration_minutes as number | null) ?? null,
      customPricing: (pricingRows ?? []) as Array<{
        service_name: string;
        price_cents: number;
        notes: string | null;
        effective_from: string;
      }>,
      today: todayInTz(args.studioTimezone),
    });
  }

  return {
    ok: true,
    sessionId,
    clientId: clientId ?? (eligibility.client?.id ?? ""),
    clientName,
    appointment: {
      id: appt.id as string,
      status: (appt.status as string | null) ?? null,
      startsAt: (appt.starts_at as string | null) ?? null,
      serviceName: svcObj?.name ?? null,
    },
    eligibility,
    defaultAmount,
  };
}

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";
import { todayInTz } from "@/lib/booking/tz";

// Bounded, tenant-scoped batch loader for the dashboard/calendar checkout cell:
// given the visible appointment ids, return each appointment's coarse
// session_payment state WITHOUT an N+1. Two bounded queries total — sessions by
// appointment id, then attempts by session id — never a per-row lookup and never
// the full payment history. Read-only; no Stripe, no writes.

export type AppointmentPaymentState =
  | "paid"
  | "processing"
  | "refunded"
  | "free" // FREE-01: the studio deliberately prices this service at $0
  | "chargeable" // has a session, no terminal charge yet (or a retryable failure)
  | "no_session"; // no treatment session for the appointment yet

type AttemptRow = { status: string | null; refund_status: string | null };

// Pure reducer: the strongest terminal state wins (paid/refunded > processing >
// chargeable). Exported for unit testing without a database.
export function deriveAppointmentPaymentState(
  hasSession: boolean,
  attempts: ReadonlyArray<AttemptRow>,
  // FREE-01. Whether the authoritative price for this appointment is an
  // explicit $0. Deliberately ranked BELOW the terminal money states: if a
  // charge somehow already succeeded, the truthful thing to show is "Paid" or
  // "Refunded", not "free". It ranks ABOVE chargeable/no_session so a free
  // visit never offers Checkout.
  isFree = false,
): AppointmentPaymentState {
  if (!hasSession) return isFree ? "free" : "no_session";
  let processing = false;
  for (const a of attempts) {
    if (a.status === "succeeded") {
      return a.refund_status === "succeeded" ? "refunded" : "paid";
    }
    if (a.status === "pending_stripe") processing = true;
  }
  if (processing) return "processing";
  if (isFree) return "free";
  return "chargeable";
}

// FREE-01. Which of these appointments are authoritatively FREE.
//
// Bounded and batched, never per-row: appointments -> services -> client
// pricing is three queries regardless of how many appointments are visible.
// It reuses the SAME pure resolver the payment surface uses, so a free visit
// on the Dashboard and a free visit on the session page can never disagree —
// and so custom-pricing precedence is honoured here too (a $0 menu service with
// a current positive client price is chargeable, not free).
async function getFreeAppointmentIds(
  studioId: string,
  appointmentIds: ReadonlyArray<string>,
  studioTimezone: string,
): Promise<Set<string>> {
  const free = new Set<string>();
  if (appointmentIds.length === 0) return free;
  const supabase = await createClient();

  // Review 3778160194 — same class as the authoritative loader (3777890267),
  // in the batched DISPLAY path. Every read here used to discard `error`, so a
  // failed query became "no rows". For client_pricing that inverts a price: a
  // $0 menu service overridden by a POSITIVE custom price resolves to `free`
  // once the custom rows vanish, and the Dashboard then shows "No payment
  // required" and suppresses Checkout for a visit that is genuinely chargeable.
  //
  // Freeness is a POSITIVE claim, so it must never be inferred from a read we
  // cannot vouch for. On any read failure this returns an empty set — nothing
  // is asserted to be free — and each appointment falls back to its ordinary
  // state. That is the safe direction: it shows Checkout rather than hiding it,
  // and it moves no money, because preparation and execution re-resolve
  // authoritatively and fail closed on their own.
  const { data: apptRows, error: apptError } = await supabase
    .from("appointments")
    .select("id, client_id, service_id, duration_minutes")
    .eq("studio_id", studioId)
    .in("id", [...appointmentIds]);
  if (apptError) return free;
  const appts = (apptRows ?? []) as Array<{
    id: string;
    client_id: string | null;
    service_id: string | null;
    duration_minutes: number | null;
  }>;
  if (appts.length === 0) return free;

  const serviceIds = [...new Set(appts.map((a) => a.service_id).filter(Boolean))] as string[];
  const clientIds = [...new Set(appts.map((a) => a.client_id).filter(Boolean))] as string[];

  const { data: serviceRows, error: serviceError } = serviceIds.length
    ? await supabase
        .from("services")
        .select("id, name, price_cents")
        .eq("studio_id", studioId)
        .in("id", serviceIds)
    : { data: [] as never[], error: null };
  if (serviceError) return free;
  const serviceById = new Map<string, { name: string; price_cents: number | null }>();
  for (const r of (serviceRows ?? []) as Array<{
    id: string;
    name: string;
    price_cents: number | null;
  }>) {
    serviceById.set(r.id, { name: r.name, price_cents: r.price_cents });
  }

  const { data: pricingRows, error: pricingError } = clientIds.length
    ? await supabase
        .from("client_pricing")
        .select("client_id, service_name, price_cents, notes, effective_from")
        .eq("studio_id", studioId)
        .in("client_id", clientIds)
    : { data: [] as never[], error: null };
  // The one Codex named: without this, a positive custom price silently
  // disappears and its $0 menu service reads as free.
  if (pricingError) return free;
  const pricingByClient = new Map<
    string,
    Array<{ service_name: string; price_cents: number; notes: string | null; effective_from: string }>
  >();
  for (const r of (pricingRows ?? []) as Array<{
    client_id: string;
    service_name: string;
    price_cents: number;
    notes: string | null;
    effective_from: string;
  }>) {
    const bucket = pricingByClient.get(r.client_id) ?? [];
    bucket.push({
      service_name: r.service_name,
      price_cents: r.price_cents,
      notes: r.notes,
      effective_from: r.effective_from,
    });
    pricingByClient.set(r.client_id, bucket);
  }

  const today = todayInTz(studioTimezone);
  for (const a of appts) {
    const svc = a.service_id ? serviceById.get(a.service_id) : null;
    const result = resolveAuthoritativeSessionPaymentAmount({
      service: svc ? { name: svc.name, price_cents: svc.price_cents } : null,
      appointmentDurationMinutes: a.duration_minutes ?? null,
      customPricing: a.client_id ? (pricingByClient.get(a.client_id) ?? []) : [],
      today,
    });
    if (result.kind === "free") free.add(a.id);
  }
  return free;
}

export async function getAppointmentPaymentStates(
  studioId: string,
  appointmentIds: ReadonlyArray<string>,
  studioTimezone: string,
): Promise<Map<string, AppointmentPaymentState>> {
  const out = new Map<string, AppointmentPaymentState>();
  const ids = [...new Set(appointmentIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const supabase = await createClient();

  // 1) Sessions for these appointments (studio-scoped + RLS). One bounded query.
  const { data: sessionRows } = await supabase
    .from("sessions")
    .select("id, appointment_id")
    .eq("studio_id", studioId)
    .in("appointment_id", ids)
    .is("deleted_at", null);

  const sessionToAppt = new Map<string, string>();
  const apptHasSession = new Set<string>();
  for (const s of (sessionRows ?? []) as Array<{
    id: string;
    appointment_id: string | null;
  }>) {
    if (!s.appointment_id) continue;
    sessionToAppt.set(s.id, s.appointment_id);
    apptHasSession.add(s.appointment_id);
  }

  // 2) session_payment attempts for those sessions. One bounded query.
  const attemptsByAppt = new Map<string, AttemptRow[]>();
  const sessionIds = [...sessionToAppt.keys()];
  if (sessionIds.length > 0) {
    const { data: attemptRows } = await supabase
      .from("payment_charge_attempts")
      .select("session_id, status, refund_status")
      .eq("studio_id", studioId)
      .eq("charge_reason", "session_payment")
      .in("session_id", sessionIds);
    for (const a of (attemptRows ?? []) as Array<{
      session_id: string;
      status: string | null;
      refund_status: string | null;
    }>) {
      const apptId = sessionToAppt.get(a.session_id);
      if (!apptId) continue;
      const bucket = attemptsByAppt.get(apptId) ?? [];
      bucket.push({ status: a.status, refund_status: a.refund_status });
      attemptsByAppt.set(apptId, bucket);
    }
  }

  const freeIds = await getFreeAppointmentIds(studioId, ids, studioTimezone);

  for (const apptId of ids) {
    out.set(
      apptId,
      deriveAppointmentPaymentState(
        apptHasSession.has(apptId),
        attemptsByAppt.get(apptId) ?? [],
        freeIds.has(apptId),
      ),
    );
  }
  return out;
}

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";
import { todayInTz } from "@/lib/booking/tz";
import {
  isSettlementMethod,
  type AppointmentSettlement,
  type SettlementMethod,
} from "@/lib/billing/settlement-types";

// PAY-SETTLE — the READ side of practitioner-attested dispositions.
//
// Bounded and batched, exactly like lib/billing/appointment-payment-state: given
// the visible appointment ids, one studio-scoped query returns the LIVE
// settlement for each. Never per-row, never the correction history — a
// superseded record is history, and history belongs on a record page, not on a
// dashboard badge.
//
// Read-only. It moves no money, writes nothing, and calls no Stripe.

/**
 * The load result distinguishes "nothing is settled" from "we could not find
 * out", because those are different claims and only one of them is a fact.
 *
 * This is the same lesson `FreeAppointmentIdsLoad` records: a failed query that
 * collapses to an empty result set turns an absence of evidence into an
 * affirmative "no disposition exists" — and UNKNOWN, in this product, is
 * precisely the state that must never be manufactured.
 */
export type AppointmentSettlementLoad =
  | { ok: true; byAppointmentId: Map<string, AppointmentSettlement> }
  | { ok: false };

type Row = {
  id: string;
  appointment_id: string;
  method: string;
  amount_cents: number;
  quoted_amount_cents: number | null;
  recorded_at: string;
  supersedes_id: string | null;
};

export async function getAppointmentSettlements(
  studioId: string,
  appointmentIds: ReadonlyArray<string>,
): Promise<AppointmentSettlementLoad> {
  const byAppointmentId = new Map<string, AppointmentSettlement>();
  const ids = [...new Set(appointmentIds)].filter(Boolean);
  if (ids.length === 0) return { ok: true, byAppointmentId };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointment_settlements")
    .select(
      "id, appointment_id, method, amount_cents, quoted_amount_cents, recorded_at, supersedes_id",
    )
    .eq("studio_id", studioId)
    // LIVE ONLY. The single-truth partial unique index guarantees at most one
    // such row per appointment, so this cannot silently pick between two.
    .is("superseded_at", null)
    .in("appointment_id", ids);

  if (error) return { ok: false };

  for (const r of (data ?? []) as Row[]) {
    // A method the runtime does not recognise is dropped rather than rendered.
    // The database's CHECK makes this unreachable today; it stays because the
    // alternative — showing an unknown financial state as if it were known — is
    // exactly the failure this release exists to end.
    if (!isSettlementMethod(r.method)) continue;
    byAppointmentId.set(r.appointment_id, {
      id: r.id,
      appointmentId: r.appointment_id,
      method: r.method,
      amountCents: r.amount_cents,
      quotedAmountCents: r.quoted_amount_cents,
      recordedAt: r.recorded_at,
      supersedesId: r.supersedes_id,
    });
  }
  return { ok: true, byAppointmentId };
}

/**
 * THE PRECEDENCE LAW, as a pure function.
 *
 * Hone-verified card money OUTRANKS any attestation. This is the same ordering
 * `deriveAppointmentPaymentState` already applies when it lets a succeeded
 * charge outrank a $0 price, and it is what makes the `still_owes` -> "paid by
 * card" progression work without anybody having to retire the older record:
 *
 *   Chloe records "client still owes" on Tuesday. The client pays by card on
 *   Friday. Tuesday's record is TRUE — it was true on Tuesday — and it stays
 *   live, immutable, with her name on it. Friday's charge simply outranks it,
 *   and FIN-01A stops counting the visit as outstanding.
 *
 * Retiring Tuesday's record automatically would mean a background actor
 * performing an owner-only correction, which is exactly the authority the
 * product decision reserved for a person.
 */
export function settlementIsOutranked(
  method: SettlementMethod,
  hasHoneVerifiedMoney: boolean,
): boolean {
  return hasHoneVerifiedMoney && method === "still_owes";
}


/**
 * THE PRICE SNAPSHOT, resolved from the APPOINTMENT.
 *
 * `getAuthoritativeSessionPaymentAmount` — the reference price the prepare
 * action uses — is SESSION-scoped, and that is correct for a card charge whose
 * amount comes off the treatment record. It is wrong for a settlement, which
 * must be recordable on a completed visit that was never charted; requiring a
 * session here would reintroduce exactly the coupling this release removes.
 *
 * So this resolves the same fact from the appointment, through the SAME pure
 * resolver (`resolveAuthoritativeSessionPaymentAmount`) that backs both the
 * prepare action and the dashboard's free-visit detection. One resolver, three
 * callers: that is what stops FIN-01A drifting away from what Checkout showed.
 * The lookup mirrors `getFreeAppointmentIds`: appointment -> service -> this
 * client's custom pricing.
 *
 * Returns null when the price cannot be resolved. Null is stored as null — a
 * zero would be a manufactured financial fact.
 */
export async function resolveAppointmentQuotedAmountCents(
  studioId: string,
  appointmentId: string,
  studioTimezone: string,
): Promise<number | null> {
  const supabase = await createClient();
  const { data: appt, error: apptError } = await supabase
    .from("appointments")
    .select("id, client_id, duration_minutes, service:services(name, price_cents)")
    .eq("studio_id", studioId)
    .eq("id", appointmentId)
    .maybeSingle();
  if (apptError || !appt) return null;

  const svcEmbed = (appt as { service?: unknown }).service;
  const svc = (Array.isArray(svcEmbed) ? svcEmbed[0] : svcEmbed) as
    | { name?: string | null; price_cents?: number | null }
    | null;
  if (!svc?.name) return null;

  const clientId = (appt as { client_id: string | null }).client_id;
  const { data: pricingRows, error: pricingError } = clientId
    ? await supabase
        .from("client_pricing")
        .select("service_name, price_cents, notes, effective_from")
        .eq("studio_id", studioId)
        .eq("client_id", clientId)
    : { data: [] as never[], error: null };
  // A failed pricing read INVERTS prices (a positive custom price over a $0
  // menu service), so it is never treated as "no custom pricing". No snapshot
  // is better than a wrong one.
  if (pricingError) return null;

  const result = resolveAuthoritativeSessionPaymentAmount({
    service: { name: svc.name, price_cents: svc.price_cents ?? null },
    appointmentDurationMinutes:
      (appt as { duration_minutes: number | null }).duration_minutes ?? null,
    customPricing: (pricingRows ?? []) as Array<{
      service_name: string;
      price_cents: number;
      notes: string | null;
      effective_from: string;
    }>,
    today: todayInTz(studioTimezone),
  });

  if (result.kind === "resolved") return result.amountCents;
  // An authoritative $0 service is a real price, and the only truthful zero.
  if (result.kind === "free") return 0;
  return null;
}

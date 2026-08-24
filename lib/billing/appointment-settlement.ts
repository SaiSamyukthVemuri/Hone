import "server-only";
import { createClient } from "@/lib/supabase/server";
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

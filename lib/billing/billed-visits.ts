import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readInChunks } from "@/lib/dashboard/in-chunks";
import { billedOutstanding, keepsRefundForBilledVisit, type BilledOutstanding, type BilledVisitRows } from "@/lib/billing/visit-payments-core";

// HON-123. The live bill of each visit (split payments), with its cash/transfer rows and refunds, for the surfaces that show a visit's payment
// state in bulk (the dashboard roster, the calendar, the unpaid list). Owner-only tables under RLS: the caller must be the owner. A failed or
// row-capped read is { ok: false }, never "no bills": the caller then shows "unavailable", not a guessed state.

export async function readBilledVisits(
  supabase: SupabaseClient,
  studioId: string,
  appointmentIds: readonly string[],
): Promise<{ ok: true; billed: Map<string, BilledVisitRows> } | { ok: false }> {
  const billed = new Map<string, BilledVisitRows>();
  if (appointmentIds.length === 0) return { ok: true, billed };
  const bills = await readInChunks<{ appointment_id: string; total_cents: number; currency: string }>(appointmentIds, (chunk) =>
    supabase.from("visit_bills").select("appointment_id, total_cents, currency").eq("studio_id", studioId).is("superseded_at", null).in("appointment_id", chunk),
  );
  if (!bills.ok) return { ok: false };
  if (bills.rows.length === 0) return { ok: true, billed };
  const ids = bills.rows.map((b) => b.appointment_id);
  const [ext, refs, attempts] = await Promise.all([
    readInChunks<{ appointment_id: string; amount_cents: number; state: string }>(ids, (chunk) =>
      supabase.from("visit_external_payments").select("appointment_id, amount_cents, state").eq("studio_id", studioId).in("appointment_id", chunk)),
    // Legacy mirrors are read too: a full refund made on the card payment itself (the older refund control, or Stripe's dashboard via the webhook) is mirrored as a legacy row,
    // and visit_payment_position counts it for a billed attempt. Dropping it left a refunded visit reading "paid".
    readInChunks<{ appointment_id: string; attempt_id: string | null; amount_cents: number; status: string; legacy: boolean }>(ids, (chunk) =>
      supabase.from("payment_refunds").select("appointment_id, attempt_id, amount_cents, status, legacy").eq("studio_id", studioId).in("appointment_id", chunk)),
    readInChunks<{ id: string }>(ids, (chunk) =>
      supabase.from("payment_charge_attempts").select("id").eq("studio_id", studioId).eq("charge_reason", "session_payment").not("visit_bill_id", "is", null).in("appointment_id", chunk)),
  ]);
  if (!ext.ok || !refs.ok || !attempts.ok) return { ok: false };
  const billedAttempts = new Set(attempts.rows.map((a) => a.id));
  for (const b of bills.rows) {
    billed.set(b.appointment_id, {
      totalCents: b.total_cents,
      currency: b.currency,
      externals: ext.rows.filter((r) => r.appointment_id === b.appointment_id).map((r) => ({ amountCents: r.amount_cents, state: r.state })),
      refunds: refs.rows.filter((r) => r.appointment_id === b.appointment_id && keepsRefundForBilledVisit({ legacy: r.legacy, attemptId: r.attempt_id }, billedAttempts)).map((r) => ({ amountCents: r.amount_cents, status: r.status })),
    });
  }
  return { ok: true, billed };
}

/** The coarse payment state a billed visit shows on the roster: paid when nothing is owed, chargeable (Checkout stays open) while something is, unavailable when unprovable. */
export function billedPaymentState(
  bill: BilledVisitRows,
  cards: ReadonlyArray<{ status: string | null; amount_cents?: number | null; currency?: string | null }>,
): "paid" | "chargeable" | "unavailable" {
  const r: BilledOutstanding = billedOutstanding(bill, cards.map((c) => ({ status: c.status, amountCents: c.amount_cents ?? null, currency: c.currency ?? null })));
  return r.kind === "paid" ? "paid" : r.kind === "owed" ? "chargeable" : "unavailable";
}

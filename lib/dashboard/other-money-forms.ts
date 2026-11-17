import "server-only";

import type { createClient } from "@/lib/supabase/server";
import { readInChunks } from "./in-chunks";

// ===========================================================================
// Every money form Hone records for an appointment, and what the unpaid balance does with it.
// ===========================================================================
//
// Privacy AO2 and Insurance U2 on #1356: "Still owes" is only as good as the list of money forms behind it. This is that list, taken
// from the schema (every public table with an amount / cents / fee / refund / price column; `tests/lib/dashboard/money-forms.test.ts`
// fails when a migration adds one that is not classified here). Each form is exactly one of:
//
//   counted      subtracted from the quote by lib/billing/outstanding-balance
//   unavailable  its presence makes the visit read "Amount unavailable" (never a guessed figure)
//   quote        a source of the price, not a payment
//   not_money    configuration, an audit copy, a card-on-file or a quantity: no payment is recorded by it
//   not_checked  recorded by database functions, but unreadable from an owner's session (RLS on, no policy), so absence cannot be
//                proved from here. NOT claimed as handled: the label says "the amount Hone can see" for exactly this reason.

export type MoneyHandling = "counted" | "unavailable" | "quote" | "not_money" | "not_checked";

export const MONEY_FORMS: ReadonlyArray<{ table: string; form: string; handling: MoneyHandling; note: string }> = [
  { table: "payment_charge_attempts", form: "session card payment (succeeded)", handling: "counted", note: "amount minus a readable succeeded refund" },
  { table: "payment_charge_attempts", form: "card payment in flight (pending_stripe)", handling: "unavailable", note: "money may or may not have moved" },
  { table: "payment_charge_attempts", form: "refund succeeded, amount unreadable", handling: "unavailable", note: "AO1: not 'no refund'" },
  { table: "payment_charge_attempts", form: "refund pending or requiring action (ours or the provider's)", handling: "unavailable", note: "the refund may or may not have moved money" },
  { table: "payment_charge_attempts", form: "refund completed by a verified cumulative full-refund receipt (a single refund may read failed or canceled beside it)", handling: "counted", note: "stripe_charge_refund_event_id: the whole charge went back, nothing kept; only whether the receipt exists is read" },
  { table: "payment_charge_attempts", form: "refund failed or canceled", handling: "counted", note: "the money stayed: the full charge is kept" },
  { table: "payment_charge_attempts", form: "charge on a soft-deleted session", handling: "unavailable", note: "U2: cannot be attributed to the visit" },
  { table: "payment_charge_attempts", form: "late-cancellation or no-show fee (succeeded or pending)", handling: "unavailable", note: "a fee is not a credit toward the session price" },
  { table: "payment_charge_attempts", form: "card money in two currencies, or not the studio's", handling: "unavailable", note: "U3: never summed" },
  { table: "manual_fee_charge_attempts", form: "manual late-cancel or no-show fee (succeeded or pending)", handling: "unavailable", note: "a fee, not a credit toward the session price" },
  { table: "appointment_settlements", form: "paid_cash, paid_e_transfer, paid_other_external", handling: "counted", note: "the amount collected; another currency is never summed" },
  { table: "appointment_settlements", form: "waived", handling: "counted", note: "owner-attested as owing nothing: the visit drops out" },
  { table: "appointment_settlements", form: "still_owes (a note)", handling: "not_money", note: "never creates or changes an amount" },
  { table: "sessions", form: "price_paid_cents recorded on the session", handling: "unavailable", note: "shown on the client page; a paid amount this balance does not subtract" },
  { table: "services", form: "price", handling: "quote", note: "via resolveAuthoritativeSessionPaymentAmount" },
  { table: "client_pricing", form: "custom price", handling: "quote", note: "via resolveAuthoritativeSessionPaymentAmount" },
  { table: "appointment_payments", form: "booking-time charge, refund, dispute state", handling: "not_checked", note: "written by database functions; no app code reads it; RLS on, no policy" },
  { table: "stripe_charge_attempts", form: "appointment-level charge", handling: "not_checked", note: "legacy Connect phase 1; RLS on, no policy" },
  { table: "stripe_refund_attempts", form: "appointment-level refund attempt", handling: "not_checked", note: "RLS on, no policy" },
  { table: "stripe_refunds", form: "appointment-level refund", handling: "not_checked", note: "RLS on, no policy" },
  { table: "stripe_disputes", form: "dispute or chargeback", handling: "not_checked", note: "RLS on, no policy; the label does not claim a final balance" },
  { table: "stripe_payment_audit", form: "audit copy of the four above", handling: "not_money", note: "no independent amount" },
  { table: "pending_booking_payment_sessions", form: "quoted price snapshot, card setup", handling: "not_money", note: "a card on file and a quote; no charge" },
  { table: "studios", form: "late_cancel_fee_cents / no_show_fee_cents", handling: "not_money", note: "policy amounts, not payments" },
  { table: "studio_payment_settings", form: "fee basis points, default currency", handling: "not_money", note: "configuration" },
  { table: "studio_payment_jurisdictions", form: "payment currency", handling: "not_money", note: "the studio's currency; compared against card money" },
  { table: "studio_payment_jurisdiction_changes", form: "currency change history", handling: "not_money", note: "audit history of the jurisdiction setting" },
  { table: "record_keeping_sterile_items", form: "amount_purchased", handling: "not_money", note: "a supply quantity" },
];

type Supabase = Awaited<ReturnType<typeof createClient>>;

const IN_FLIGHT_OR_TAKEN = ["pending_stripe", "succeeded"];

/**
 * Money forms an OWNER session can read that the balance does not subtract, for the given (already owed) appointments. A failed read
 * is { ok: false }: absence of evidence is not a balance.
 */
export async function readOtherMoneyForms(
  supabase: Supabase,
  studioId: string,
  appointmentIds: readonly string[],
  livemode: boolean,
): Promise<{ ok: true; forms: Map<string, Set<string>> } | { ok: false }> {
  const [fees, manual] = await Promise.all([
    readInChunks<{ appointment_id: string | null }>(appointmentIds, (chunk) =>
      supabase
        .from("payment_charge_attempts")
        .select("appointment_id")
        .eq("studio_id", studioId)
        .in("charge_reason", ["late_cancellation_fee", "no_show_fee"])
        .in("status", IN_FLIGHT_OR_TAKEN)
        .eq("stripe_livemode", livemode)
        .in("appointment_id", chunk),
    ),
    readInChunks<{ appointment_id: string | null }>(appointmentIds, (chunk) =>
      supabase
        .from("manual_fee_charge_attempts")
        .select("appointment_id")
        .eq("studio_id", studioId)
        .in("status", IN_FLIGHT_OR_TAKEN)
        .eq("stripe_livemode", livemode)
        .in("appointment_id", chunk),
    ),
  ]);
  if (!fees.ok || !manual.ok) return { ok: false };
  const forms = new Map<string, Set<string>>();
  const add = (appt: string | null, form: string) => {
    if (appt) (forms.get(appt) ?? forms.set(appt, new Set()).get(appt)!).add(form);
  };
  for (const r of fees.rows) add(r.appointment_id, "fee_charge");
  for (const r of manual.rows) add(r.appointment_id, "manual_fee_charge");
  return { ok: true, forms };
}

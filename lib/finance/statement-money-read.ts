import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readInChunks } from "@/lib/dashboard/in-chunks";
import { aggregateRefundGaps } from "@/lib/billing/visit-payments-core";

import type { StatementCardRow, StatementLegacyFeeRow } from "./statement";
import type { AssembleAppointment, AssembleSettlementRow } from "./statement-document-assemble";

// ===========================================================================
// Shared READ-ONLY helpers for the client statement and the studio directory. Invoker client only (row-level security decides what is visible),
// no service role, no write, no Stripe, no mail. Callers run the OWNER GATE first; nothing here checks a role.
// FAILS CLOSED: any failed or row-capped read is `{ ok: false }`; a partial answer is never returned as a whole one.
// ===========================================================================

const PAGE = 500; // well under the 1000-row cap, so a page can never be silently truncated
export const MAX_PAGES = 20; // 10,000 appointments per read
/** A read of this many rows or more fails as too many (the loop below stops at MAX_PAGES full pages). */
export const APPOINTMENT_READ_CAP = MAX_PAGES * PAGE;
const FEE_REASONS = ["no_show_fee", "late_cancellation_fee"];

type ApptDb = {
  id: string;
  client_id: string | null;
  starts_at: string;
  status: string;
  practitioner_id: string | null;
  service_id: string | null;
  duration_minutes: number | null;
};

export type AppointmentScope = { clientId?: string; startUtc?: string; endUtc?: string };

/** Appointments of one studio, by keyset paging over (starts_at, id). Scope: one client and/or a half-open UTC window. */
export async function readAppointmentsKeyset(
  supabase: SupabaseClient,
  studioId: string,
  scope: AppointmentScope,
): Promise<{ ok: true; rows: AssembleAppointment[] } | { ok: false; reason: "read_failed" | "too_many_appointments" }> {
  const rows: ApptDb[] = [];
  let cursor: { startsAt: string; id: string } | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) return { ok: false, reason: "too_many_appointments" };
    let q = supabase
      .from("appointments")
      .select("id, client_id, starts_at, status, practitioner_id, service_id, duration_minutes")
      .eq("studio_id", studioId);
    if (scope.clientId) q = q.eq("client_id", scope.clientId);
    if (scope.startUtc) q = q.gte("starts_at", scope.startUtc);
    if (scope.endUtc) q = q.lt("starts_at", scope.endUtc);
    q = q.order("starts_at", { ascending: true }).order("id", { ascending: true }).limit(PAGE);
    if (cursor) q = q.or(`starts_at.gt."${cursor.startsAt}",and(starts_at.eq."${cursor.startsAt}",id.gt."${cursor.id}")`);
    const { data, error } = await q;
    if (error) return { ok: false, reason: "read_failed" };
    const got = (data ?? []) as unknown as ApptDb[];
    if (got.length > PAGE) return { ok: false, reason: "read_failed" };
    rows.push(...got);
    if (got.length < PAGE) break;
    const last = got[got.length - 1];
    cursor = { startsAt: last.starts_at, id: last.id };
  }
  const seen = new Set<string>();
  for (const a of rows) {
    // appointments.client_id is NOT NULL in the schema, so a null here is a corrupt read, not a real visit: fail closed (never a guess, never a silent drop).
    if (seen.has(a.id) || !a.client_id) return { ok: false, reason: "read_failed" };
    if (scope.clientId && a.client_id !== scope.clientId) return { ok: false, reason: "read_failed" };
    seen.add(a.id);
  }
  return {
    ok: true,
    rows: rows.map((a) => ({
      id: a.id,
      clientId: a.client_id as string,
      startsAt: a.starts_at,
      status: a.status,
      practitionerId: a.practitioner_id,
      serviceId: a.service_id,
      durationMinutes: a.duration_minutes,
    })),
  };
}

type CardDb = {
  id: string;
  charge_reason: string | null;
  status: string | null;
  amount_cents: number | null;
  currency: string | null;
  refund_status: string | null;
  refund_amount_cents: number | null;
  stripe_refund_status: string | null;
  stripe_refund_id: string | null;
  stripe_charge_refund_event_id: string | null;
  stripe_livemode: boolean | null;
  appointment_id: string | null;
  session_id: string | null;
};
const CARD_COLS =
  "id, charge_reason, status, amount_cents, currency, refund_status, refund_amount_cents, stripe_refund_status, stripe_refund_id, stripe_charge_refund_event_id, stripe_livemode, appointment_id, session_id";

export type MoneyRows = { cardRows: StatementCardRow[]; settlementRows: AssembleSettlementRow[]; legacyFeeRows: StatementLegacyFeeRow[] };

/** Every money row linked to these appointments (card, owner-recorded settlement, legacy fee ledger). */
export async function readMoneyForAppointments(supabase: SupabaseClient, studioId: string, ids: readonly string[]): Promise<({ ok: true } & MoneyRows) | { ok: false }> {
  if (ids.length === 0) return { ok: true, cardRows: [], settlementRows: [], legacyFeeRows: [] };
  const sessions = await readInChunks<{ id: string; appointment_id: string | null }>(ids, (chunk) =>
    supabase.from("sessions").select("id, appointment_id").eq("studio_id", studioId).in("appointment_id", chunk),
  );
  if (!sessions.ok) return { ok: false };
  const sessionToAppt = new Map<string, string>();
  for (const s of sessions.rows) if (s.appointment_id) sessionToAppt.set(s.id, s.appointment_id);

  // HON-123 / HON-122: the split-payments ledger, read as settlement-shaped rows so every existing total, line and print follows without a second model.
  // The three reads fail closed together with the rest: a visit whose bill, cash/transfer or refund rows cannot be read is never shown without them.
  const [bills, externals, refunds, reviews] = await Promise.all([
    readInChunks<{ appointment_id: string; total_cents: number | null; currency: string | null }>(ids, (chunk) =>
      supabase.from("visit_bills").select("appointment_id, total_cents, currency").eq("studio_id", studioId).is("superseded_at", null).in("appointment_id", chunk),
    ),
    readInChunks<{ appointment_id: string; method: string; amount_cents: number | null; currency: string | null; state: string }>(ids, (chunk) =>
      supabase.from("visit_external_payments").select("appointment_id, method, amount_cents, currency, state").eq("studio_id", studioId).in("appointment_id", chunk),
    ),
    readInChunks<{ appointment_id: string | null; attempt_id: string | null; amount_cents: number | null; currency: string | null; status: string; legacy: boolean; kind: string }>(ids, (chunk) =>
      supabase.from("payment_refunds").select("appointment_id, attempt_id, amount_cents, currency, status, legacy, kind").eq("studio_id", studioId).in("appointment_id", chunk),
    ),
    // OPEN reviews (a refund made in the Stripe dashboard that the owner has not confirmed): the visit is unresolved until then, never "paid".
    readInChunks<{ appointment_id: string | null; attempt_id: string | null; amount_cents: number | null; currency: string | null }>(ids, (chunk) =>
      supabase.from("payment_refund_reviews").select("appointment_id, attempt_id, amount_cents, currency").eq("studio_id", studioId).is("resolved_at", null).in("appointment_id", chunk),
    ),
  ]);
  if (!bills.ok || !externals.ok || !refunds.ok || !reviews.ok) return { ok: false };
  const ledgerRows: AssembleSettlementRow[] = [];
  for (const e of externals.rows) {
    if (e.state === "voided") continue; // retracted before any money moved: nothing to show
    // Confirmed money is cash / e-transfer / other as the owner recorded it. A transfer still waiting for confirmation is owed, not received.
    ledgerRows.push({ appointmentId: e.appointment_id, method: e.state === "confirmed" ? e.method : "still_owes", amountCents: e.amount_cents, currency: e.currency, quotedAmountCents: null });
  }
  const [feeCards, sessionCardsBySession, sessionCardsByAppt, settlements, legacy] = await Promise.all([
    readInChunks<CardDb>(ids, (chunk) =>
      supabase.from("payment_charge_attempts").select(CARD_COLS).eq("studio_id", studioId).in("charge_reason", FEE_REASONS).in("appointment_id", chunk),
    ),
    sessionToAppt.size === 0
      ? Promise.resolve({ ok: true as const, rows: [] as CardDb[] })
      : readInChunks<CardDb>([...sessionToAppt.keys()], (chunk) =>
          supabase.from("payment_charge_attempts").select(CARD_COLS).eq("studio_id", studioId).eq("charge_reason", "session_payment").in("session_id", chunk),
        ),
    // The same payments read BY APPOINTMENT (as readBilledVisits does): a soft-deleted chart still holds real money, so a live card on it and its refunds must not drop out of the statement.
    readInChunks<CardDb>(ids, (chunk) =>
      supabase.from("payment_charge_attempts").select(CARD_COLS).eq("studio_id", studioId).eq("charge_reason", "session_payment").in("appointment_id", chunk),
    ),
    readInChunks<{ appointment_id: string; method: string; amount_cents: number | null; currency: string | null; quoted_amount_cents: number | null }>(ids, (chunk) =>
      supabase
        .from("appointment_settlements")
        .select("appointment_id, method, amount_cents, currency, quoted_amount_cents")
        .eq("studio_id", studioId)
        .is("superseded_at", null)
        .in("appointment_id", chunk),
    ),
    readInChunks<{ appointment_id: string; status: string | null; amount_cents: number | null; currency: string | null; stripe_livemode: boolean | null }>(ids, (chunk) =>
      supabase.from("manual_fee_charge_attempts").select("appointment_id, status, amount_cents, currency, stripe_livemode").eq("studio_id", studioId).in("appointment_id", chunk),
    ),
  ]);
  if (!feeCards.ok || !sessionCardsBySession.ok || !sessionCardsByAppt.ok || !settlements.ok || !legacy.ok) return { ok: false };
  // Union by id: a payment read both ways is one payment (visits without a deleted chart are unchanged).
  const sessionCards = { rows: [...new Map([...sessionCardsBySession.rows, ...sessionCardsByAppt.rows].map((r) => [r.id, r] as const)).values()] };

  // Only a LIVE card payment is real money. A refund row that points at an attempt is real only when that attempt is live (cash and transfer refunds have no attempt).
  const liveAttempt = new Set<string>([...feeCards.rows, ...sessionCards.rows].filter((r) => r.stripe_livemode === true).map((r) => r.id));
  // Succeeded PRICE REDUCTIONS are already inside the bill total; a payment reversal is not (Sam, 27 Nov 2026: a reversal never reopens a balance, as visit_payment_position, 0394).
  // A reduction on a TEST-mode (or unknown-mode) card payment is test money: that card is excluded from the statement, so the reduction must not lower the bill either (0394 studio_has_gone_live).
  const reducedOf = (appointmentId: string) => refunds.rows.filter((r) => r.appointment_id === appointmentId && !r.legacy && !(r.attempt_id && !liveAttempt.has(r.attempt_id)) && r.kind === "price_reduction" && r.status === "succeeded").reduce((n, r) => n + (r.amount_cents ?? 0), 0);
  for (const b of bills.rows) ledgerRows.push({ appointmentId: b.appointment_id, method: "bill_total", amountCents: null, currency: b.currency, quotedAmountCents: b.total_cents, reducedCents: reducedOf(b.appointment_id) });
  // An attempt that has its own split refunds is shown through THOSE rows. When the split refunds add up to the whole charge the webhook also marks the attempt itself
  // fully refunded (0240), and showing that full-refund line as well as each split refund would count the same money twice (two $50 refunds must read $100, not $200).
  const splitRefundedAttempts = new Set<string>();
  for (const r of refunds.rows) if (!r.legacy && r.attempt_id && r.status !== "failed") splitRefundedAttempts.add(r.attempt_id);
  for (const r of refunds.rows) {
    // Stripe TEST-mode money is never real money (the statement counts live card money only, so does this): a refund of a test or unknown-mode card payment adds nothing.
    if (r.attempt_id && !liveAttempt.has(r.attempt_id)) continue;
    // A legacy row mirrors a full refund the attempt itself already carries (the card line shows it), and a failed refund moved nothing.
    if (r.legacy || r.status === "failed" || !r.appointment_id) continue;
    ledgerRows.push({ appointmentId: r.appointment_id, method: r.status === "succeeded" ? "partial_refund" : "refund_in_flight", amountCents: r.amount_cents, currency: r.currency, quotedAmountCents: null, ...(r.status === "succeeded" ? {} : { pendingCents: r.amount_cents ?? 0 }) });
  }

  for (const rv of reviews.rows) {
    if (rv.attempt_id && !liveAttempt.has(rv.attempt_id)) continue; // a review of a test-mode payment is not real money
    if (rv.appointment_id) ledgerRows.push({ appointmentId: rv.appointment_id, method: "refund_in_flight", amountCents: rv.amount_cents, currency: rv.currency, quotedAmountCents: null, pendingCents: rv.amount_cents ?? 0 });
  }
  const cardRows: StatementCardRow[] = [];
  // One payment is one row, however many reads returned it.
  for (const r of [...new Map([...feeCards.rows, ...sessionCards.rows].map((x) => [x.id, x] as const)).values()]) {
    const appointmentId = r.appointment_id ?? (r.session_id ? sessionToAppt.get(r.session_id) ?? null : null);
    if (!appointmentId) continue;
    // The attempt's own refund columns are Stripe's CUMULATIVE statement of the whole payment (0078, 0240). Its split rows are shown through their own lines
    // (above), but when the columns say MORE came back than those rows (the rest was refunded in the Stripe dashboard) the difference is one more line, so
    // the statement reads the same money as payment_refund_money (0393): the greater of the two, never the sum.
    if (liveAttempt.has(r.id) && splitRefundedAttempts.has(r.id) && r.status === "succeeded" && typeof r.amount_cents === "number") {
      const mine = refunds.rows.filter((x) => x.attempt_id === r.id && !x.legacy);
      const gap = aggregateRefundGaps(
        { id: r.id, amountCents: r.amount_cents, refundStatus: r.refund_status, refundAmountCents: r.refund_amount_cents },
        mine.filter((x) => x.status === "succeeded").reduce((n, x) => n + (x.amount_cents ?? 0), 0), mine.filter((x) => x.status === "pending_stripe").reduce((n, x) => n + (x.amount_cents ?? 0), 0),
      );
      if (gap.succeededGapCents > 0) ledgerRows.push({ appointmentId, method: "partial_refund", amountCents: gap.succeededGapCents, currency: r.currency, quotedAmountCents: null });
      if (gap.pendingGapCents > 0) ledgerRows.push({ appointmentId, method: "refund_in_flight", amountCents: gap.pendingGapCents, currency: r.currency, quotedAmountCents: null, pendingCents: gap.pendingGapCents });
    }
    cardRows.push({
      appointmentId,
      chargeReason: r.charge_reason,
      status: r.status,
      amountCents: r.amount_cents,
      currency: r.currency,
      // The split refunds of this attempt are shown through their own rows (above): its full-refund mirror is not emitted a second time.
      refundStatus: splitRefundedAttempts.has(r.id) ? null : r.refund_status,
      refundAmountCents: splitRefundedAttempts.has(r.id) ? null : r.refund_amount_cents,
      providerRefundStatus: splitRefundedAttempts.has(r.id) ? null : r.stripe_refund_status,
      stripeRefundId: splitRefundedAttempts.has(r.id) ? null : r.stripe_refund_id,
      cumulativeFullRefundVerified: !splitRefundedAttempts.has(r.id) && typeof r.stripe_charge_refund_event_id === "string" && r.stripe_charge_refund_event_id.length > 0,
      stripeLivemode: r.stripe_livemode,
    });
  }
  return {
    ok: true,
    cardRows,
    settlementRows: [...ledgerRows, ...settlements.rows.map((r) => ({ appointmentId: r.appointment_id, method: r.method, amountCents: r.amount_cents, currency: r.currency, quotedAmountCents: r.quoted_amount_cents }))],
    legacyFeeRows: legacy.rows.map((r) => ({ appointmentId: r.appointment_id, status: r.status, amountCents: r.amount_cents, currency: r.currency, stripeLivemode: r.stripe_livemode })),
  };
}

/** Service and practitioner names for the appointments. A failed name read only drops names (the document flags it); it never changes a figure. */
export async function readVisitNames(
  supabase: SupabaseClient,
  studioId: string,
  appts: readonly AssembleAppointment[],
): Promise<{ serviceNames: Map<string, string>; practitionerNames: Map<string, string> }> {
  const serviceIds = [...new Set(appts.map((a) => a.serviceId).filter(Boolean))] as string[];
  const practitionerIds = [...new Set(appts.map((a) => a.practitionerId).filter(Boolean))] as string[];
  const svc = serviceIds.length
    ? await readInChunks<{ id: string; name: string }>(serviceIds, (chunk) => supabase.from("services").select("id, name").eq("studio_id", studioId).in("id", chunk))
    : { ok: true as const, rows: [] as { id: string; name: string }[] };
  const prac = practitionerIds.length
    ? await readInChunks<{ id: string; display_name: string | null }>(practitionerIds, (chunk) => supabase.from("practitioners").select("id, display_name").eq("studio_id", studioId).in("id", chunk))
    : { ok: true as const, rows: [] as { id: string; display_name: string | null }[] };
  const serviceNames = new Map<string, string>(svc.ok ? svc.rows.map((s) => [s.id, s.name]) : []);
  const practitionerNames = new Map<string, string>();
  if (prac.ok) for (const r of prac.rows) if (r.display_name && r.display_name.trim()) practitionerNames.set(r.id, r.display_name.trim());
  return { serviceNames, practitionerNames };
}

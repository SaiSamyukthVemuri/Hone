import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readInChunks } from "@/lib/dashboard/in-chunks";

import type { StatementCardRow, StatementLegacyFeeRow } from "./statement";
import type { AssembleAppointment, AssembleSettlementRow } from "./statement-document-assemble";

// ===========================================================================
// Shared READ-ONLY helpers for the client statement and the studio directory. Invoker client only (row-level security decides what is visible),
// no service role, no write, no Stripe, no mail. Callers run the OWNER GATE first; nothing here checks a role.
// FAILS CLOSED: any failed or row-capped read is `{ ok: false }`; a partial answer is never returned as a whole one.
// ===========================================================================

const PAGE = 500; // well under the 1000-row cap, so a page can never be silently truncated
export const MAX_PAGES = 20; // 10,000 appointments per read
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
    if (seen.has(a.id) || !a.client_id) return { ok: false, reason: "read_failed" }; // a repeat, or a visit with no client, cannot be attributed
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

  const [feeCards, sessionCards, settlements, legacy] = await Promise.all([
    readInChunks<CardDb>(ids, (chunk) =>
      supabase.from("payment_charge_attempts").select(CARD_COLS).eq("studio_id", studioId).in("charge_reason", FEE_REASONS).in("appointment_id", chunk),
    ),
    sessionToAppt.size === 0
      ? Promise.resolve({ ok: true as const, rows: [] as CardDb[] })
      : readInChunks<CardDb>([...sessionToAppt.keys()], (chunk) =>
          supabase.from("payment_charge_attempts").select(CARD_COLS).eq("studio_id", studioId).eq("charge_reason", "session_payment").in("session_id", chunk),
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
  if (!feeCards.ok || !sessionCards.ok || !settlements.ok || !legacy.ok) return { ok: false };

  const cardRows: StatementCardRow[] = [];
  for (const r of [...feeCards.rows, ...sessionCards.rows]) {
    const appointmentId = r.appointment_id ?? (r.session_id ? sessionToAppt.get(r.session_id) ?? null : null);
    if (!appointmentId) continue;
    cardRows.push({
      appointmentId,
      chargeReason: r.charge_reason,
      status: r.status,
      amountCents: r.amount_cents,
      currency: r.currency,
      refundStatus: r.refund_status,
      refundAmountCents: r.refund_amount_cents,
      providerRefundStatus: r.stripe_refund_status,
      stripeRefundId: r.stripe_refund_id,
      cumulativeFullRefundVerified: typeof r.stripe_charge_refund_event_id === "string" && r.stripe_charge_refund_event_id.length > 0,
      stripeLivemode: r.stripe_livemode,
    });
  }
  return {
    ok: true,
    cardRows,
    settlementRows: settlements.rows.map((r) => ({ appointmentId: r.appointment_id, method: r.method, amountCents: r.amount_cents, currency: r.currency, quotedAmountCents: r.quoted_amount_cents })),
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

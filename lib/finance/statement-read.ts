import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { utcInstantFromLocal } from "@/lib/booking/tz";
import { clientDisplayName } from "@/lib/clients/identity";
import { createClient } from "@/lib/supabase/server";
import { readInChunks } from "@/lib/dashboard/in-chunks";
import type { Studio } from "@/lib/types/database";

import { isYearMonth, monthRange, STATEMENT_MAX_SANE_MONTH, STATEMENT_MIN_MONTH, type YearMonth } from "./statement-period";
import {
  buildStatement,
  type Statement,
  type StatementCardRow,
  type StatementLegacyFeeRow,
  type StatementSettlementRow,
} from "./statement";

// ===========================================================================
// HON-64 Slice A: the read behind /financials/statement. READ-ONLY.
// ===========================================================================
//
// No INSERT, UPDATE, DELETE, RPC, Stripe call or migration. Every money read runs as the SIGNED-IN OWNER through the invoker client, under
// RLS: payment_charge_attempts, manual_fee_charge_attempts and appointment_settlements are owner-readable only (0254), and for anyone else
// they return zero rows WITH NO ERROR, which would read as "no money". So the owner gate is the FIRST statement and no client is built
// for a non-owner. No service-role client is used here. (The studio's currency comes from the existing jurisdiction helper, passed in by
// the caller, which is not money data.)
//
// FAILS CLOSED. Any failed or row-capped read (PostgREST truncates at max_rows without an error) makes the whole statement
// `unavailable`: a partial month is never shown as a complete one.
//
// IT STARTS FROM THE MONTH'S APPOINTMENTS (by the appointment's start, in the studio's timezone) and finds the money on them. Money not
// linked to such an appointment is therefore outside this statement, and the page says so.

const FEE_REASONS = ["no_show_fee", "late_cancellation_fee"];
const APPT_CAP = 1000;

export type StatementView =
  | { access: "refused" }
  | { access: "granted"; ok: false; reason: "read_failed" | "too_many_appointments" | "currency_unknown" | "month_out_of_range" }
  | {
      access: "granted";
      ok: true;
      month: YearMonth;
      label: string;
      timezone: string;
      startLocal: string;
      endLocalExclusive: string;
      statement: Statement;
      visitInfo: Record<string, { clientName: string; clientId: string | null; serviceName: string | null; minutes: number | null }>;
<<<<<<< HEAD
      /**
       * COMPLETED visits in the period with NO money line of any kind, listed so the Studio table can say "No payment recorded". It is a LISTING only: these
       * visits carry no amount, are not in `statement` (so in no total, method figure or count of money), and nothing about them implies an amount owed.
       * Which appointments qualify is the statement's existing visit rule (a completed treatment is a visit; cancelled, no-show and not-yet-completed
       * bookings are not), the same period window and the same owner gate as the rest of this read.
       */
      noPaymentVisits: { appointmentId: string; startsAt: string; practitionerId: string | null }[];
=======
>>>>>>> origin/claude/build-hone-saas-hOex7
      /** Practitioner id -> display name, for the owner. A name that could not be read is simply absent (the page then says so); it never changes a figure. */
      practitionerNames: Record<string, string>;
      /**
       * Appointment id -> the price the visit was SETTLED against (the settlement's own recorded quote), for the visits that have exactly one live
       * settlement carrying one. Used ONLY to word a row's status pill honestly (money collected below the quote is not "Paid"); it feeds no total.
       * A visit with no settlement, no quote, or two disagreeing live quotes is simply absent.
       */
      settlementQuotes: Record<string, number>;
    };

/** Whole minutes between a visit's start and end, or null when either is missing, unreadable, or the end is not after the start. */
export function visitMinutes(startsAt: string, endsAt: string | null): number | null {
  if (!endsAt) return null;
  const ms = Date.parse(endsAt) - Date.parse(startsAt);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 60000);
}

type ApptRow = {
  id: string;
  status: string | null;
  starts_at: string;
  ends_at: string | null;
  client_id: string | null;
  practitioner_id: string | null;
  service_id: string | null;
  clients: { name: string | null; preferred_name: string | null } | { name: string | null; preferred_name: string | null }[] | null;
};

export async function loadStatementView(
  practitioner: { readonly role: string },
  studio: Pick<Studio, "id" | "timezone">,
  month: YearMonth,
  studioCurrency: string | null,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<StatementView> {
  // FIRST STATEMENT. Nothing below runs for a non-owner: no client, no query.
  if (practitioner.role !== "owner") return { access: "refused" };
  if (!isYearMonth(month) || month < STATEMENT_MIN_MONTH || month > STATEMENT_MAX_SANE_MONTH) return { access: "granted", ok: false, reason: "month_out_of_range" };
  if (!studioCurrency) return { access: "granted", ok: false, reason: "currency_unknown" };

  const supabase = supabaseClient ?? (await createClient());
  const range = monthRange(month);
  // Two separate local-midnight instants, never start + 30 days (a DST day is 23 or 25 hours).
  const startUtc = utcInstantFromLocal(range.startLocal, "00:00", studio.timezone).toISOString();
  const endUtc = utcInstantFromLocal(range.endLocalExclusive, "00:00", studio.timezone).toISOString();

  const { data: apptData, error: apptError } = await supabase
    .from("appointments")
<<<<<<< HEAD
    .select("id, status, starts_at, ends_at, client_id, practitioner_id, service_id, clients(name, preferred_name)")
=======
    .select("id, starts_at, ends_at, client_id, practitioner_id, service_id, clients(name, preferred_name)")
>>>>>>> origin/claude/build-hone-saas-hOex7
    .eq("studio_id", studio.id)
    .gte("starts_at", startUtc)
    .lt("starts_at", endUtc)
    .order("starts_at", { ascending: true })
    .limit(APPT_CAP);
  if (apptError) return { access: "granted", ok: false, reason: "read_failed" };
  const appts = (apptData ?? []) as unknown as ApptRow[];
  if (appts.length >= APPT_CAP) return { access: "granted", ok: false, reason: "too_many_appointments" };

  const ids = appts.map((a) => a.id);
  const empty = buildStatement({ studioCurrency, appointments: [], cardRows: [], settlementRows: [], legacyFeeRows: [] });
  if (ids.length === 0) {
<<<<<<< HEAD
    return { access: "granted", ok: true, month, label: range.label, timezone: studio.timezone, startLocal: range.startLocal, endLocalExclusive: range.endLocalExclusive, statement: empty, visitInfo: {}, practitionerNames: {}, settlementQuotes: {}, noPaymentVisits: [] };
=======
    return { access: "granted", ok: true, month, label: range.label, timezone: studio.timezone, startLocal: range.startLocal, endLocalExclusive: range.endLocalExclusive, statement: empty, visitInfo: {}, practitionerNames: {}, settlementQuotes: {} };
>>>>>>> origin/claude/build-hone-saas-hOex7
  }

  // Sessions of those appointments (deleted ones included: money on them is still money, attributed by appointment).
  const sessions = await readInChunks<{ id: string; appointment_id: string | null }>(ids, (chunk) =>
    supabase.from("sessions").select("id, appointment_id").eq("studio_id", studio.id).in("appointment_id", chunk),
  );
  if (!sessions.ok) return { access: "granted", ok: false, reason: "read_failed" };
  const sessionToAppt = new Map<string, string>();
  for (const s of sessions.rows) if (s.appointment_id) sessionToAppt.set(s.id, s.appointment_id);

  const CARD_COLS =
    "id, charge_reason, status, amount_cents, currency, refund_status, refund_amount_cents, stripe_refund_status, stripe_refund_id, stripe_charge_refund_event_id, stripe_livemode, appointment_id, session_id";
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

  const [feeCards, sessionCards, settlements, legacy] = await Promise.all([
    readInChunks<CardDb>(ids, (chunk) =>
      supabase.from("payment_charge_attempts").select(CARD_COLS).eq("studio_id", studio.id).in("charge_reason", FEE_REASONS).in("appointment_id", chunk),
    ),
    sessionToAppt.size === 0
      ? Promise.resolve({ ok: true as const, rows: [] as CardDb[] })
      : readInChunks<CardDb>([...sessionToAppt.keys()], (chunk) =>
          supabase.from("payment_charge_attempts").select(CARD_COLS).eq("studio_id", studio.id).eq("charge_reason", "session_payment").in("session_id", chunk),
        ),
    readInChunks<{ appointment_id: string; method: string; amount_cents: number | null; currency: string | null; quoted_amount_cents: number | null }>(ids, (chunk) =>
      supabase.from("appointment_settlements").select("appointment_id, method, amount_cents, currency, quoted_amount_cents").eq("studio_id", studio.id).is("superseded_at", null).in("appointment_id", chunk),
    ),
    readInChunks<{ appointment_id: string; status: string | null; amount_cents: number | null; currency: string | null; stripe_livemode: boolean | null }>(ids, (chunk) =>
      supabase.from("manual_fee_charge_attempts").select("appointment_id, status, amount_cents, currency, stripe_livemode").eq("studio_id", studio.id).in("appointment_id", chunk),
    ),
  ]);
  if (!feeCards.ok || !sessionCards.ok || !settlements.ok || !legacy.ok) return { access: "granted", ok: false, reason: "read_failed" };

  const cardRows: StatementCardRow[] = [];
  for (const r of [...feeCards.rows, ...sessionCards.rows]) {
    const appointmentId = r.appointment_id ?? (r.session_id ? sessionToAppt.get(r.session_id) ?? null : null);
    if (!appointmentId) continue; // not linked to a visit in this month: outside this statement
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
  const settlementRows: StatementSettlementRow[] = settlements.rows.map((r) => ({
    appointmentId: r.appointment_id,
    method: r.method,
    amountCents: r.amount_cents,
    currency: r.currency,
  }));
  const legacyFeeRows: StatementLegacyFeeRow[] = legacy.rows.map((r) => ({
    appointmentId: r.appointment_id,
    status: r.status,
    amountCents: r.amount_cents,
    currency: r.currency,
    stripeLivemode: r.stripe_livemode,
  }));

  const statement = buildStatement({
    studioCurrency,
    appointments: appts.map((a) => ({ id: a.id, practitionerId: a.practitioner_id, startsAt: a.starts_at })),
    cardRows,
    settlementRows,
    legacyFeeRows,
  });

  // Service names for the visit lines. A failed read only drops the name; it never changes a figure.
  const serviceIds = [...new Set(appts.map((a) => a.service_id).filter(Boolean))] as string[];
  const svc = serviceIds.length
    ? await readInChunks<{ id: string; name: string }>(serviceIds, (chunk) => supabase.from("services").select("id, name").eq("studio_id", studio.id).in("id", chunk))
    : { ok: true as const, rows: [] as { id: string; name: string }[] };
  const svcName = new Map(svc.ok ? svc.rows.map((s) => [s.id, s.name]) : []);

  const practitionerIds = [...new Set(appts.map((a) => a.practitioner_id).filter(Boolean))] as string[];
  const prac = practitionerIds.length
    ? await readInChunks<{ id: string; display_name: string | null }>(practitionerIds, (chunk) => supabase.from("practitioners").select("id, display_name").eq("studio_id", studio.id).in("id", chunk))
    : { ok: true as const, rows: [] as { id: string; display_name: string | null }[] };
  const practitionerNames: Record<string, string> = {};
  if (prac.ok) for (const r of prac.rows) if (r.display_name && r.display_name.trim()) practitionerNames[r.id] = r.display_name.trim();

  const visitInfo: Record<string, { clientName: string; clientId: string | null; serviceName: string | null; minutes: number | null }> = {};
  for (const a of appts) {
    const c = Array.isArray(a.clients) ? a.clients[0] : a.clients;
    visitInfo[a.id] = {
      clientName: c ? clientDisplayName({ name: c.name ?? "", preferred_name: c.preferred_name }) : "Client",
      clientId: a.client_id,
      serviceName: a.service_id ? svcName.get(a.service_id) ?? null : null,
      // The booked length, from the appointment's own start and end; absent (never zero) when either is missing or the end is not after the start.
      minutes: visitMinutes(a.starts_at, a.ends_at),
    };
  }

  const settlementQuotes: Record<string, number> = {};
  const disagreeing = new Set<string>();
  for (const r of settlements.rows) {
    if (typeof r.quoted_amount_cents !== "number" || !Number.isInteger(r.quoted_amount_cents) || r.quoted_amount_cents < 0) continue;
    const prior = settlementQuotes[r.appointment_id];
    if (prior !== undefined && prior !== r.quoted_amount_cents) disagreeing.add(r.appointment_id);
    settlementQuotes[r.appointment_id] = r.quoted_amount_cents;
  }
  for (const id of disagreeing) delete settlementQuotes[id];

<<<<<<< HEAD
  // Completed visits with no money line at all. The ONE visit rule is "a completed treatment is a visit" (statement-document's eligibility): a cancelled,
  // no-show or not-yet-completed booking is not promoted to a visit here either. A visit that has ANY money line (even one counted in no total) is already in
  // statement.visits and is not repeated.
  const withMoney = new Set(statement.visits.map((v) => v.appointmentId));
  const noPaymentVisits = appts
    .filter((a) => a.status === "completed" && !withMoney.has(a.id))
    .map((a) => ({ appointmentId: a.id, startsAt: a.starts_at, practitionerId: a.practitioner_id }));

=======
>>>>>>> origin/claude/build-hone-saas-hOex7
  return {
    access: "granted",
    ok: true,
    month,
    label: range.label,
    timezone: studio.timezone,
    startLocal: range.startLocal,
    endLocalExclusive: range.endLocalExclusive,
    statement,
    visitInfo,
    practitionerNames,
    settlementQuotes,
<<<<<<< HEAD
    noPaymentVisits,
=======
>>>>>>> origin/claude/build-hone-saas-hOex7
  };
}

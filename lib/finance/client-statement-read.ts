import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { clientDisplayName } from "@/lib/clients/identity";
import { readInChunks } from "@/lib/dashboard/in-chunks";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import type { StatementCardRow, StatementLegacyFeeRow } from "./statement";
import { assembleClientInputs, type AssembleAppointment, type AssembleSettlementRow } from "./statement-document-assemble";
import type { DocumentVisitInput, FeeItemInput } from "./statement-document";

// ===========================================================================
// The read behind a client's statement or invoice. READ-ONLY, owner-only, fail-closed.
// ===========================================================================
//
// No INSERT, UPDATE, DELETE, RPC, Stripe call, mail or migration, and NO service-role client: every read runs as the signed-in owner through the
// invoker client under RLS. The money tables are owner-readable only (0254); for any other role they return zero rows WITH NO ERROR, which would
// read as "no money". So the owner gate is the FIRST statement and no client is built, and no query is made, for anyone else.
//
// STUDIO AND CLIENT come from the signed-in practitioner's studio and a client id that is verified to belong to that studio BEFORE any visit or
// money is read. A client of another studio and an unknown id give the SAME `client_not_found`, so an id cannot be probed across studios.
//
// IT STARTS FROM THE CLIENT'S APPOINTMENTS (appointment-first), so a visit with no money row is kept. Appointments are read by KEYSET paging
// ((starts_at, id), 500 per page), never one capped read: the whole history is read, in full, or the read fails. The document built from it is
// therefore computed over the FULL scope; presentation paging (a later screen) slices the finished document and cannot change a count or a total.
//
// FAILS CLOSED. Any failed read, any money read that reaches the row cap (PostgREST truncates without an error), or a history beyond MAX_PAGES
// makes the whole read unavailable. A partial history is never presented as a complete one.

const PAGE = 500; // well under the 1000-row cap, so a page can never be silently truncated
export const MAX_PAGES = 20; // 10,000 appointments for one client
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEE_REASONS = ["no_show_fee", "late_cancellation_fee"];

export type ClientStatementRead =
  | { access: "refused" }
  | { access: "granted"; ok: false; reason: "read_failed" | "too_many_appointments" | "currency_unknown" | "invalid_client" | "client_not_found" }
  | {
      access: "granted";
      ok: true;
      client: { id: string; name: string };
      timezone: string;
      studioCurrency: string;
      visits: DocumentVisitInput[];
      feeItems: FeeItemInput[];
      /** Appointments left off the document that nevertheless carry money (a future booking with a payment). */
      offDocumentWithMoney: number;
    };

type ApptDb = {
  id: string;
  client_id: string;
  starts_at: string;
  status: string;
  practitioner_id: string | null;
  service_id: string | null;
  duration_minutes: number | null;
};
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

export async function loadClientStatementRead(
  practitioner: { readonly role: string },
  studio: Pick<Studio, "id" | "timezone">,
  studioCurrency: string | null,
  clientId: string,
  now: Date,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<ClientStatementRead> {
  // FIRST STATEMENT. Nothing below runs for a non-owner.
  if (practitioner.role !== "owner") return { access: "refused" };
  if (!studioCurrency) return { access: "granted", ok: false, reason: "currency_unknown" };
  if (typeof clientId !== "string" || !UUID.test(clientId)) return { access: "granted", ok: false, reason: "invalid_client" };

  const supabase = supabaseClient ?? (await createClient());
  const failed = { access: "granted", ok: false, reason: "read_failed" } as const;

  // The client must belong to THIS studio before anything else is read.
  const { data: clientRow, error: clientError } = await supabase
    .from("clients")
    .select("id, name, preferred_name")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientError) return failed;
  if (!clientRow) return { access: "granted", ok: false, reason: "client_not_found" };
  const clientName = clientDisplayName({ name: (clientRow as { name: string | null }).name ?? "", preferred_name: (clientRow as { preferred_name: string | null }).preferred_name });

  // Appointment-first, keyset-paged over the full history.
  const appts: ApptDb[] = [];
  let cursor: { startsAt: string; id: string } | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) return { access: "granted", ok: false, reason: "too_many_appointments" };
    let q = supabase
      .from("appointments")
      .select("id, client_id, starts_at, status, practitioner_id, service_id, duration_minutes")
      .eq("studio_id", studio.id)
      .eq("client_id", clientId)
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.or(`starts_at.gt."${cursor.startsAt}",and(starts_at.eq."${cursor.startsAt}",id.gt."${cursor.id}")`);
    const { data, error } = await q;
    if (error) return failed;
    const rows = (data ?? []) as unknown as ApptDb[];
    if (rows.length > PAGE) return failed;
    appts.push(...rows);
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1];
    cursor = { startsAt: last.starts_at, id: last.id };
  }
  // Defence in depth: nothing from another client or a repeated row can enter.
  if (appts.some((a) => a.client_id !== clientId)) return failed;
  const seen = new Set<string>();
  for (const a of appts) {
    if (seen.has(a.id)) return failed;
    seen.add(a.id);
  }

  const emptyOk = (): ClientStatementRead => ({ access: "granted", ok: true, client: { id: clientId, name: clientName }, timezone: studio.timezone, studioCurrency, visits: [], feeItems: [], offDocumentWithMoney: 0 });
  if (appts.length === 0) return emptyOk();
  const ids = appts.map((a) => a.id);

  const sessions = await readInChunks<{ id: string; appointment_id: string | null }>(ids, (chunk) =>
    supabase.from("sessions").select("id, appointment_id").eq("studio_id", studio.id).in("appointment_id", chunk),
  );
  if (!sessions.ok) return failed;
  const sessionToAppt = new Map<string, string>();
  for (const s of sessions.rows) if (s.appointment_id) sessionToAppt.set(s.id, s.appointment_id);

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
      supabase
        .from("appointment_settlements")
        .select("appointment_id, method, amount_cents, currency, quoted_amount_cents")
        .eq("studio_id", studio.id)
        .is("superseded_at", null)
        .in("appointment_id", chunk),
    ),
    readInChunks<{ appointment_id: string; status: string | null; amount_cents: number | null; currency: string | null; stripe_livemode: boolean | null }>(ids, (chunk) =>
      supabase.from("manual_fee_charge_attempts").select("appointment_id, status, amount_cents, currency, stripe_livemode").eq("studio_id", studio.id).in("appointment_id", chunk),
    ),
  ]);
  if (!feeCards.ok || !sessionCards.ok || !settlements.ok || !legacy.ok) return failed;

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
  const settlementRows: AssembleSettlementRow[] = settlements.rows.map((r) => ({
    appointmentId: r.appointment_id,
    method: r.method,
    amountCents: r.amount_cents,
    currency: r.currency,
    quotedAmountCents: r.quoted_amount_cents,
  }));
  const legacyFeeRows: StatementLegacyFeeRow[] = legacy.rows.map((r) => ({
    appointmentId: r.appointment_id,
    status: r.status,
    amountCents: r.amount_cents,
    currency: r.currency,
    stripeLivemode: r.stripe_livemode,
  }));

  // Names only decorate a visit; a failed name read drops the name (the document flags it) and never changes a figure.
  const serviceIds = [...new Set(appts.map((a) => a.service_id).filter(Boolean))] as string[];
  const svc = serviceIds.length
    ? await readInChunks<{ id: string; name: string }>(serviceIds, (chunk) => supabase.from("services").select("id, name").eq("studio_id", studio.id).in("id", chunk))
    : { ok: true as const, rows: [] as { id: string; name: string }[] };
  const practitionerIds = [...new Set(appts.map((a) => a.practitioner_id).filter(Boolean))] as string[];
  const prac = practitionerIds.length
    ? await readInChunks<{ id: string; display_name: string | null }>(practitionerIds, (chunk) => supabase.from("practitioners").select("id, display_name").eq("studio_id", studio.id).in("id", chunk))
    : { ok: true as const, rows: [] as { id: string; display_name: string | null }[] };
  const serviceNames = new Map<string, string>(svc.ok ? svc.rows.map((s) => [s.id, s.name]) : []);
  const practitionerNames = new Map<string, string>();
  if (prac.ok) for (const r of prac.rows) if (r.display_name && r.display_name.trim()) practitionerNames.set(r.id, r.display_name.trim());

  const assembled = assembleClientInputs({
    studioCurrency,
    timezone: studio.timezone,
    nowIso: now.toISOString(),
    appointments: appts.map<AssembleAppointment>((a) => ({
      id: a.id,
      clientId: a.client_id,
      startsAt: a.starts_at,
      status: a.status,
      practitionerId: a.practitioner_id,
      serviceId: a.service_id,
      durationMinutes: a.duration_minutes,
    })),
    cardRows,
    settlementRows,
    legacyFeeRows,
    serviceNames,
    practitionerNames,
  });

  return {
    access: "granted",
    ok: true,
    client: { id: clientId, name: clientName },
    timezone: studio.timezone,
    studioCurrency,
    visits: assembled.visits,
    feeItems: assembled.feeItems,
    offDocumentWithMoney: assembled.offDocumentWithMoney,
  };
}

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { todayInTz } from "@/lib/booking/tz";
import { clientDisplayName } from "@/lib/clients/identity";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { outstandingForAppointment } from "@/lib/billing/outstanding-balance";
import { deriveAppointmentPaymentState } from "@/lib/billing/appointment-payment-state";
import type { UnpaidAttention } from "./needs-attention-model";
import { readInChunks } from "./in-chunks";
import { readOtherMoneyForms } from "./other-money-forms";

// ===========================================================================
// Finished appointments with money still owed: the OWNER-ONLY loader.
// ===========================================================================
//
// Read-only. It reads the money tables and writes nothing, anywhere. The caller must be the owner: payment_charge_attempts and
// appointment_settlements are owner-readable only (0254), and for anyone else those reads return zero rows WITH NO ERROR, which would
// read as "nothing owed". So a non-owner call is refused here, before any query.
//
// The balance is the AUTHORITATIVE one from lib/billing/outstanding-balance (quote minus Hone-verified card money kept minus collected
// settlements). A settlement note never creates an amount. Anything that cannot be determined is { kind: "unavailable" }, shown as
// "Amount unavailable", never 0. A read that fails for the whole set is { ok: false }, a named unavailable check, never an empty list.
//
// Bounded: a look-back window (90 days by default, or every finished appointment for "All outstanding") and a row cap. When the cap is
// reached the result says so (`notReturned`) so the panel can print that the list is not exhaustive.

export const UNPAID_DEFAULT_WINDOW_DAYS = 90;
export const UNPAID_ROW_CAP = 200;

export type UnpaidLoad =
  | { ok: true; items: UnpaidAttention[]; notReturned: number; windowDays: number | null; unlisted: number }
  | { ok: false };

type ApptRow = {
  id: string;
  client_id: string | null;
  service_id: string | null;
  duration_minutes: number | null;
  ends_at: string;
  status: string | null;
  clients: { name: string | null; preferred_name: string | null } | { name: string | null; preferred_name: string | null }[] | null;
};

export async function loadUnpaidAttention(opts: {
  studioId: string;
  studioTimezone: string;
  viewerIsOwner: boolean;
  now: Date;
  /** null = every finished appointment ("All outstanding"). */
  windowDays: number | null;
}): Promise<UnpaidLoad> {
  if (!opts.viewerIsOwner) return { ok: false };
  const { studioId } = opts;
  const supabase = await createClient();
  const nowIso = opts.now.toISOString();

  let q = supabase
    .from("appointments")
    .select("id, client_id, service_id, duration_minutes, ends_at, status, clients(name, preferred_name)")
    .eq("studio_id", studioId)
    .eq("status", "completed")
    .lte("ends_at", nowIso)
    .order("ends_at", { ascending: false })
    .limit(UNPAID_ROW_CAP * 3);
  if (opts.windowDays !== null) {
    q = q.gte("ends_at", new Date(opts.now.getTime() - opts.windowDays * 86_400_000).toISOString());
  }
  const { data: apptData, error: apptError } = await q;
  if (apptError) return { ok: false };
  const appts = (apptData ?? []) as unknown as ApptRow[];
  if (appts.length === 0) return { ok: true, items: [], notReturned: 0, windowDays: opts.windowDays, unlisted: 0 };
  const ids = appts.map((a) => a.id);
  const livemode = inferStripeLivemode();

  // Sessions (INCLUDING deleted ones: a charge on a deleted session is money we cannot attribute, so it is named, not ignored)
  // -> session_payment attempts (mode-scoped, like every other payment read) -> the card money kept per appointment.
  const sessions = await readInChunks<{ id: string; appointment_id: string | null; deleted_at: string | null; price_paid_cents: number | null }>(ids, (chunk) =>
    supabase.from("sessions").select("id, appointment_id, deleted_at, price_paid_cents").eq("studio_id", studioId).in("appointment_id", chunk),
  );
  if (!sessions.ok) return { ok: false };
  const sessionToAppt = new Map<string, { appt: string; deleted: boolean }>();
  const unproven = new Map<string, Set<string>>();
  const flag = (appt: string, form: string) => (unproven.get(appt) ?? unproven.set(appt, new Set()).get(appt)!).add(form);
  for (const s of sessions.rows) {
    if (!s.appointment_id) continue;
    sessionToAppt.set(s.id, { appt: s.appointment_id, deleted: Boolean(s.deleted_at) });
    // A price recorded on the session is money Hone shows elsewhere (the client page) and this balance does not subtract.
    if (!s.deleted_at && typeof s.price_paid_cents === "number" && s.price_paid_cents > 0) flag(s.appointment_id, "session_price_recorded");
  }

  type Card = {
    status: string | null;
    amountCents: number | null;
    refundStatus: string | null;
    refundAmountCents: number | null;
    providerRefundStatus: string | null;
    cumulativeFullRefundVerified: boolean;
    currency: string | null;
  };
  const cardsByAppt = new Map<string, Card[]>();
  if (sessionToAppt.size > 0) {
    const attempts = await readInChunks<{
      id: string;
      created_at: string;
      session_id: string;
      status: string | null;
      amount_cents: number | null;
      refund_status: string | null;
      refund_amount_cents: number | null;
      stripe_refund_status: string | null;
      stripe_charge_refund_event_id: string | null;
      currency: string | null;
    }>([...sessionToAppt.keys()], (chunk) =>
      supabase
        .from("payment_charge_attempts")
        .select("id, created_at, session_id, status, amount_cents, refund_status, refund_amount_cents, stripe_refund_status, stripe_charge_refund_event_id, currency")
        .eq("studio_id", studioId)
        .eq("charge_reason", "session_payment")
        .eq("stripe_livemode", livemode)
        .in("session_id", chunk),
    );
    if (!attempts.ok) return { ok: false };
    // The same fixed order the appointment page reads in (created_at, id): its reducer returns on the first succeeded row.
    const ordered = [...attempts.rows].sort((x, y) => (x.created_at ?? "").localeCompare(y.created_at ?? "") || (x.id ?? "").localeCompare(y.id ?? ""));
    for (const a of ordered) {
      const owner = sessionToAppt.get(a.session_id);
      if (!owner) continue;
      if (owner.deleted) {
        // Money taken (or in flight) against a deleted session cannot be matched to the visit: never subtracted, never ignored.
        if (a.status === "succeeded" || a.status === "pending_stripe") flag(owner.appt, "deleted_session_charge");
        continue;
      }
      const bucket = cardsByAppt.get(owner.appt) ?? [];
      bucket.push({
        status: a.status,
        amountCents: a.amount_cents,
        refundStatus: a.refund_status,
        refundAmountCents: a.refund_amount_cents,
        providerRefundStatus: a.stripe_refund_status,
        cumulativeFullRefundVerified: typeof a.stripe_charge_refund_event_id === "string" && a.stripe_charge_refund_event_id.length > 0,
        currency: a.currency,
      });
      cardsByAppt.set(owner.appt, bucket);
    }
  }

  // Live collections. At most one live row per appointment (the single-truth index).
  const settleRead = await readInChunks<{ appointment_id: string; method: string; amount_cents: number; quoted_amount_cents: number | null; currency: string | null }>(ids, (chunk) =>
    supabase.from("appointment_settlements").select("appointment_id, method, amount_cents, quoted_amount_cents, currency").eq("studio_id", studioId).is("superseded_at", null).in("appointment_id", chunk),
  );
  if (!settleRead.ok) return { ok: false };
  const settlements = new Map<string, Array<{ method: never; amountCents: number; currency: string | null }>>();
  // The price the visit was SETTLED against (0187 keeps it on the settlement). A later price change must not reopen a settled visit.
  const settledQuote = new Map<string, number>();
  for (const r of settleRead.rows) {
    if (typeof r.quoted_amount_cents === "number" && r.quoted_amount_cents >= 0) settledQuote.set(r.appointment_id, r.quoted_amount_cents);
    const b = settlements.get(r.appointment_id) ?? [];
    b.push({ method: r.method as never, amountCents: r.amount_cents, currency: r.currency });
    settlements.set(r.appointment_id, b);
  }

  // The quote. A failed read leaves every quote unknown (-> "Amount unavailable"), never a guessed or zero price.
  const serviceIds = [...new Set(appts.map((a) => a.service_id).filter(Boolean))] as string[];
  const clientIds = [...new Set(appts.map((a) => a.client_id).filter(Boolean))] as string[];
  const [svc, pricing] = await Promise.all([
    readInChunks<{ id: string; name: string; price_cents: number | null }>(serviceIds, (chunk) =>
      supabase.from("services").select("id, name, price_cents").eq("studio_id", studioId).in("id", chunk),
    ),
    readInChunks<{ client_id: string; service_name: string; price_cents: number; notes: string | null; effective_from: string }>(clientIds, (chunk) =>
      supabase.from("client_pricing").select("client_id, service_name, price_cents, notes, effective_from").eq("studio_id", studioId).in("client_id", chunk),
    ),
  ]);
  // A failed or row-capped services / client_pricing read is a FAILED CHECK (the "unpaid balances unavailable" line), never an empty list: it would
  // read as "nothing owed". Individual visits whose price is unknown are skipped and counted below.
  if (!svc.ok || !pricing.ok) return { ok: false };
  const serviceById = new Map<string, { name: string; price_cents: number | null }>();
  if (svc.ok) for (const r of svc.rows) serviceById.set(r.id, { name: r.name, price_cents: r.price_cents });
  const pricingByClient = new Map<string, Array<{ service_name: string; price_cents: number; notes: string | null; effective_from: string }>>();
  if (pricing.ok) {
    for (const r of pricing.rows) {
      const b = pricingByClient.get(r.client_id) ?? [];
      b.push({ service_name: r.service_name, price_cents: r.price_cents, notes: r.notes, effective_from: r.effective_from });
      pricingByClient.set(r.client_id, b);
    }
  }

  const jurisdiction = await getStudioPaymentJurisdiction(studioId);
  if (!jurisdiction.ok) return { ok: false }; // an unreadable jurisdiction is a failed check too
  const studioCurrency = jurisdiction.jurisdiction.currency;
  const today = todayInTz(opts.studioTimezone);

  const evaluate = (a: ApptRow) => {
    let quoteCents: number | null = null;
    // Same priority as the settlement coverage logic (lib/billing/settlement-coverage.ts): the settlement's recorded quote first; today's
    // price only when none was recorded. There is no booked-price snapshot on appointments, so nothing sits between the two.
    const recorded = settledQuote.get(a.id);
    if (recorded !== undefined) {
      quoteCents = recorded;
    } else {
      const s = a.service_id ? serviceById.get(a.service_id) : null;
      const r = resolveAuthoritativeSessionPaymentAmount({
        service: s ? { name: s.name, price_cents: s.price_cents } : null,
        appointmentDurationMinutes: a.duration_minutes ?? null,
        customPricing: a.client_id ? (pricingByClient.get(a.client_id) ?? []) : [],
        today,
      });
      quoteCents = r.kind === "resolved" ? r.amountCents : r.kind === "free" ? 0 : null;
    }
    return outstandingForAppointment({
      status: a.status,
      endsAt: a.ends_at,
      now: nowIso,
      quoteCents,
      quoteIsCurrentPrice: recorded === undefined,
      studioCurrency,
      cards: cardsByAppt.get(a.id) ?? [],
      settlements: settlements.get(a.id) ?? [],
      unprovenMoney: [...(unproven.get(a.id) ?? [])],
    });
  };

  // Pass 1: which visits would show an amount. Only those need the remaining money forms looked up (a visit that is paid, free or
  // already unavailable shows no figure, so nothing more can make it wrong).
  const owedIds = appts.filter((a) => evaluate(a).kind === "owed").map((a) => a.id);
  if (owedIds.length > 0) {
    const other = await readOtherMoneyForms(supabase, studioId, owedIds, livemode);
    if (!other.ok) return { ok: false };
    for (const [appt, forms] of other.forms) for (const f of forms) flag(appt, f);
  }

  const items: UnpaidAttention[] = [];
  let seen = 0;
  // Finished visits Hone could not price or verify. Skipped, and COUNTED, so the owner is never led to think every visit was checked.
  let unlisted = 0;
  for (const a of appts) {
    const result = evaluate(a);
    if (result.kind === "paid" || result.kind === "not_applicable") continue;
    // HON-65: never contradict the appointment page. When it reads this visit as "Paid" (a Hone-verified card charge that was not refunded,
    // the same reducer the page uses), the dashboard neither lists it NOR counts it as unknown, whatever today's price or any other money form says.
    const cards = cardsByAppt.get(a.id) ?? [];
    if (cards.length > 0 && deriveAppointmentPaymentState(true, cards.map((c) => ({ status: c.status, refund_status: c.refundStatus, amount_cents: c.amountCents, refund_amount_cents: c.refundAmountCents }))) === "paid") continue;
    // List a visit only when Hone can ESTABLISH that money is still owed. An amount Hone cannot determine is not a reason to nag, but it is counted.
    if (result.kind === "amount_unavailable") {
      unlisted += 1;
      continue;
    }
    seen += 1;
    if (items.length >= UNPAID_ROW_CAP) continue;
    const c = Array.isArray(a.clients) ? a.clients[0] : a.clients;
    items.push({
      appointmentId: a.id,
      clientId: a.client_id ?? `appointment:${a.id}`,
      clientName: c ? clientDisplayName({ name: c.name, preferred_name: c.preferred_name } as never) || "Client" : "Client deleted",
      endsAt: a.ends_at,
      balance:
        result.kind === "owed"
          ? { kind: "owed", outstandingCents: result.outstandingCents, currency: result.currency.toLowerCase() }
          : { kind: "unavailable" },
    });
  }
  // The look-back query itself is capped; if it filled up, older finished appointments were not examined.
  const examinedCapped = appts.length >= UNPAID_ROW_CAP * 3;
  return { ok: true, items, notReturned: Math.max(0, seen - items.length) + (examinedCapped ? 1 : 0), windowDays: opts.windowDays, unlisted };
}

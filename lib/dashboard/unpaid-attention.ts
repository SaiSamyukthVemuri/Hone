import "server-only";

import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { todayInTz } from "@/lib/booking/tz";
import { clientDisplayName } from "@/lib/clients/identity";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { outstandingForAppointment } from "@/lib/billing/outstanding-balance";
import type { UnpaidAttention } from "./needs-attention-model";

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
  | { ok: true; items: UnpaidAttention[]; notReturned: number; windowDays: number | null }
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
  if (appts.length === 0) return { ok: true, items: [], notReturned: 0, windowDays: opts.windowDays };
  const ids = appts.map((a) => a.id);

  // Sessions -> session_payment attempts (mode-scoped, like every other payment read) -> the card money kept per appointment.
  const { data: sessionRows, error: sessionError } = await supabase.from("sessions").select("id, appointment_id").eq("studio_id", studioId).in("appointment_id", ids).is("deleted_at", null);
  if (sessionError) return { ok: false };
  const sessionToAppt = new Map<string, string>();
  for (const s of (sessionRows ?? []) as Array<{ id: string; appointment_id: string | null }>) if (s.appointment_id) sessionToAppt.set(s.id, s.appointment_id);

  type Card = { status: string | null; amountCents: number | null; refundStatus: string | null; refundAmountCents: number | null; currency: string | null };
  const cardsByAppt = new Map<string, Card[]>();
  if (sessionToAppt.size > 0) {
    const { data: attemptRows, error: attemptError } = await supabase
      .from("payment_charge_attempts")
      .select("session_id, status, amount_cents, refund_status, refund_amount_cents, currency")
      .eq("studio_id", studioId)
      .eq("charge_reason", "session_payment")
      .eq("stripe_livemode", inferStripeLivemode())
      .in("session_id", [...sessionToAppt.keys()]);
    if (attemptError) return { ok: false };
    for (const a of (attemptRows ?? []) as Array<{ session_id: string; status: string | null; amount_cents: number | null; refund_status: string | null; refund_amount_cents: number | null; currency: string | null }>) {
      const appt = sessionToAppt.get(a.session_id);
      if (!appt) continue;
      const bucket = cardsByAppt.get(appt) ?? [];
      bucket.push({ status: a.status, amountCents: a.amount_cents, refundStatus: a.refund_status, refundAmountCents: a.refund_amount_cents, currency: a.currency });
      cardsByAppt.set(appt, bucket);
    }
  }

  // Live collections. At most one live row per appointment (the single-truth index).
  const { data: settleRows, error: settleError } = await supabase.from("appointment_settlements").select("appointment_id, method, amount_cents").eq("studio_id", studioId).is("superseded_at", null).in("appointment_id", ids);
  if (settleError) return { ok: false };
  const settlements = new Map<string, Array<{ method: never; amountCents: number }>>();
  for (const r of (settleRows ?? []) as Array<{ appointment_id: string; method: string; amount_cents: number }>) {
    const b = settlements.get(r.appointment_id) ?? [];
    b.push({ method: r.method as never, amountCents: r.amount_cents });
    settlements.set(r.appointment_id, b);
  }

  // The quote. A failed read leaves every quote unknown (-> "Amount unavailable"), never a guessed or zero price.
  const serviceIds = [...new Set(appts.map((a) => a.service_id).filter(Boolean))] as string[];
  const clientIds = [...new Set(appts.map((a) => a.client_id).filter(Boolean))] as string[];
  const [svc, pricing] = await Promise.all([
    serviceIds.length ? supabase.from("services").select("id, name, price_cents").eq("studio_id", studioId).in("id", serviceIds) : Promise.resolve({ data: [] as never[], error: null }),
    clientIds.length ? supabase.from("client_pricing").select("client_id, service_name, price_cents, notes, effective_from").eq("studio_id", studioId).in("client_id", clientIds) : Promise.resolve({ data: [] as never[], error: null }),
  ]);
  const quotesReadable = !svc.error && !pricing.error;
  const serviceById = new Map<string, { name: string; price_cents: number | null }>();
  for (const r of (svc.data ?? []) as Array<{ id: string; name: string; price_cents: number | null }>) serviceById.set(r.id, { name: r.name, price_cents: r.price_cents });
  const pricingByClient = new Map<string, Array<{ service_name: string; price_cents: number; notes: string | null; effective_from: string }>>();
  for (const r of (pricing.data ?? []) as Array<{ client_id: string; service_name: string; price_cents: number; notes: string | null; effective_from: string }>) {
    const b = pricingByClient.get(r.client_id) ?? [];
    b.push({ service_name: r.service_name, price_cents: r.price_cents, notes: r.notes, effective_from: r.effective_from });
    pricingByClient.set(r.client_id, b);
  }

  const jurisdiction = await getStudioPaymentJurisdiction(studioId);
  const studioCurrency = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;
  const today = todayInTz(opts.studioTimezone);

  const items: UnpaidAttention[] = [];
  let seen = 0;
  for (const a of appts) {
    let quoteCents: number | null = null;
    if (quotesReadable) {
      const s = a.service_id ? serviceById.get(a.service_id) : null;
      const r = resolveAuthoritativeSessionPaymentAmount({
        service: s ? { name: s.name, price_cents: s.price_cents } : null,
        appointmentDurationMinutes: a.duration_minutes ?? null,
        customPricing: a.client_id ? (pricingByClient.get(a.client_id) ?? []) : [],
        today,
      });
      quoteCents = r.kind === "resolved" ? r.amountCents : r.kind === "free" ? 0 : null;
    }
    const result = outstandingForAppointment({
      status: a.status,
      endsAt: a.ends_at,
      now: nowIso,
      quoteCents,
      studioCurrency,
      cards: cardsByAppt.get(a.id) ?? [],
      settlements: settlements.get(a.id) ?? [],
    });
    if (result.kind === "paid" || result.kind === "not_applicable") continue;
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
  return { ok: true, items, notReturned: Math.max(0, seen - items.length) + (examinedCapped ? 1 : 0), windowDays: opts.windowDays };
}

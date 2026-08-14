import "server-only";
import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";
import { todayInTz } from "@/lib/booking/tz";

// Bounded, tenant-scoped batch loader for the dashboard/calendar checkout cell:
// given the visible appointment ids, return each appointment's coarse
// session_payment state WITHOUT an N+1. Two bounded queries total: sessions by
// appointment id, then attempts by session id, never a per-row lookup and never
// the full payment history. Read-only; no Stripe, no writes.

export type AppointmentPaymentState =
  | "paid"
  | "processing"
  | "refunded"
  | "free" // FREE-01: the studio deliberately prices this service at $0
  | "chargeable" // has a session, no terminal charge yet (or a retryable failure)
  | "no_session" // no treatment session for the appointment yet
  // Reviews 3779063521 / 3779063523. A read this state DEPENDS ON failed, so
  // Hone does not know. This is deliberately its own state rather than being
  // folded into no_session / chargeable / free: an absence produced by a failed
  // query is not a fact, and each of those three is an affirmative claim.
  // Collapsing a failure into any of them previously rendered Checkout over an
  // unknown price, or hid a pending/paid/refunded charge behind "no session".
  | "unavailable";

type AttemptRow = { status: string | null; refund_status: string | null };

// Pure reducer: the strongest terminal state wins (paid/refunded > processing >
// chargeable). Exported for unit testing without a database.
export function deriveAppointmentPaymentState(
  hasSession: boolean,
  attempts: ReadonlyArray<AttemptRow>,
  // FREE-01. Whether the authoritative price for this appointment is an
  // explicit $0. Deliberately ranked BELOW the terminal money states: if a
  // charge somehow already succeeded, the truthful thing to show is "Paid" or
  // "Refunded", not "free". It ranks ABOVE chargeable/no_session so a free
  // visit never offers Checkout.
  isFree = false,
): AppointmentPaymentState {
  if (!hasSession) return isFree ? "free" : "no_session";
  let processing = false;
  for (const a of attempts) {
    if (a.status === "succeeded") {
      return a.refund_status === "succeeded" ? "refunded" : "paid";
    }
    if (a.status === "pending_stripe") processing = true;
  }
  if (processing) return "processing";
  if (isFree) return "free";
  return "chargeable";
}

// FREE-01. Which of these appointments are authoritatively FREE.
//
// Bounded and batched, never per-row: appointments -> services -> client
// pricing is three queries regardless of how many appointments are visible.
// It reuses the SAME pure resolver the payment surface uses, so a free visit
// on the Dashboard and a free visit on the session page can never disagree,
// and so custom-pricing precedence is honoured here too (a $0 menu service with
// a current positive client price is chargeable, not free).
// The free lookup must be able to say "I could not find out". Returning a bare
// Set made a failed read indistinguishable from an authoritative "nothing here
// is free", so the caller silently rendered Checkout without knowing the price.
export type FreeAppointmentIdsLoad =
  | { ok: true; freeAppointmentIds: Set<string> }
  | { ok: false };

async function getFreeAppointmentIds(
  studioId: string,
  appointmentIds: ReadonlyArray<string>,
  studioTimezone: string,
): Promise<FreeAppointmentIdsLoad> {
  const free = new Set<string>();
  if (appointmentIds.length === 0) return { ok: true, freeAppointmentIds: free };
  const supabase = await createClient();

  // Review 3778160194, same class as the authoritative loader (3777890267),
  // in the batched DISPLAY path. Every read here used to discard `error`, so a
  // failed query became "no rows". For client_pricing that inverts a price: a
  // $0 menu service overridden by a POSITIVE custom price resolves to `free`
  // once the custom rows vanish, and the Dashboard then shows "No payment
  // required" and suppresses Checkout for a visit that is genuinely chargeable.
  //
  // Freeness is a POSITIVE claim, so it must never be inferred from a read we
  // cannot vouch for. On any read failure this returns an empty set, nothing
  // is asserted to be free, and each appointment falls back to its ordinary
  // state. That is the safe direction: it shows Checkout rather than hiding it,
  // and it moves no money, because preparation and execution re-resolve
  // authoritatively and fail closed on their own.
  const { data: apptRows, error: apptError } = await supabase
    .from("appointments")
    .select("id, client_id, service_id, duration_minutes")
    .eq("studio_id", studioId)
    .in("id", [...appointmentIds]);
  if (apptError) return { ok: false };
  const appts = (apptRows ?? []) as Array<{
    id: string;
    client_id: string | null;
    service_id: string | null;
    duration_minutes: number | null;
  }>;
  if (appts.length === 0) return { ok: true, freeAppointmentIds: free };

  const serviceIds = [...new Set(appts.map((a) => a.service_id).filter(Boolean))] as string[];
  const clientIds = [...new Set(appts.map((a) => a.client_id).filter(Boolean))] as string[];

  const { data: serviceRows, error: serviceError } = serviceIds.length
    ? await supabase
        .from("services")
        .select("id, name, price_cents")
        .eq("studio_id", studioId)
        .in("id", serviceIds)
    : { data: [] as never[], error: null };
  if (serviceError) return { ok: false };
  const serviceById = new Map<string, { name: string; price_cents: number | null }>();
  for (const r of (serviceRows ?? []) as Array<{
    id: string;
    name: string;
    price_cents: number | null;
  }>) {
    serviceById.set(r.id, { name: r.name, price_cents: r.price_cents });
  }

  const { data: pricingRows, error: pricingError } = clientIds.length
    ? await supabase
        .from("client_pricing")
        .select("client_id, service_name, price_cents, notes, effective_from")
        .eq("studio_id", studioId)
        .in("client_id", clientIds)
    : { data: [] as never[], error: null };
  // The one Codex named: without this, a positive custom price silently
  // disappears and its $0 menu service reads as free.
  if (pricingError) return { ok: false };
  const pricingByClient = new Map<
    string,
    Array<{ service_name: string; price_cents: number; notes: string | null; effective_from: string }>
  >();
  for (const r of (pricingRows ?? []) as Array<{
    client_id: string;
    service_name: string;
    price_cents: number;
    notes: string | null;
    effective_from: string;
  }>) {
    const bucket = pricingByClient.get(r.client_id) ?? [];
    bucket.push({
      service_name: r.service_name,
      price_cents: r.price_cents,
      notes: r.notes,
      effective_from: r.effective_from,
    });
    pricingByClient.set(r.client_id, bucket);
  }

  const today = todayInTz(studioTimezone);
  for (const a of appts) {
    const svc = a.service_id ? serviceById.get(a.service_id) : null;
    const result = resolveAuthoritativeSessionPaymentAmount({
      service: svc ? { name: svc.name, price_cents: svc.price_cents } : null,
      appointmentDurationMinutes: a.duration_minutes ?? null,
      customPricing: a.client_id ? (pricingByClient.get(a.client_id) ?? []) : [],
      today,
    });
    if (result.kind === "free") free.add(a.id);
  }
  return { ok: true, freeAppointmentIds: free };
}

export async function getAppointmentPaymentStates(
  studioId: string,
  appointmentIds: ReadonlyArray<string>,
  studioTimezone: string,
): Promise<Map<string, AppointmentPaymentState>> {
  const out = new Map<string, AppointmentPaymentState>();
  const ids = [...new Set(appointmentIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const supabase = await createClient();

  // 1) Sessions for these appointments (studio-scoped + RLS). One bounded query.
  // Review 3778292139, transaction state must be TRUSTWORTHY before freeness
  // may be applied. `deriveAppointmentPaymentState` returns
  // `isFree ? "free" : "no_session"` when hasSession is false, so a failed
  // sessions or attempts read (which collapses to an empty row set) combined
  // with a SUCCESSFUL pricing read renders "No payment required" over a real
  // pending_stripe or succeeded charge: inverting the precedence that ranks
  // processing/paid/refunded above free.
  const { data: sessionRows, error: sessionError } = await supabase
    .from("sessions")
    .select("id, appointment_id")
    .eq("studio_id", studioId)
    .in("appointment_id", ids)
    .is("deleted_at", null);

  const sessionToAppt = new Map<string, string>();
  const apptHasSession = new Set<string>();
  for (const s of (sessionRows ?? []) as Array<{
    id: string;
    appointment_id: string | null;
  }>) {
    if (!s.appointment_id) continue;
    sessionToAppt.set(s.id, s.appointment_id);
    apptHasSession.add(s.appointment_id);
  }

  // 2) session_payment attempts for those sessions. One bounded query.
  //
  // R-05 / REL-005. Mode-scoped, for the same reason every other payment read
  // is (0103 settings, 0104 cards, 0105 attempts). Migration 0105 deliberately
  // rescoped payment_charge_attempts_active_session_payment_uniq to
  // (session_id, stripe_livemode), so one TEST and one LIVE attempt may
  // legitimately coexist for the same session. This read had no mode
  // predicate, so `deriveAppointmentPaymentState` -- which returns on the FIRST
  // succeeded row and never looks at mode -- let pre-launch TEST history decide
  // a LIVE badge: a refunded test-mode attempt rendered "Refunded", a succeeded
  // one "Paid", an abandoned pending_stripe one a permanent "Processing", and
  // each of those suppressed Checkout on a chargeable appointment. The
  // session-detail surface has always read this ledger mode-scoped, so the two
  // surfaces could contradict each other.
  //
  // Scoped to the DEPLOYMENT mode (not the row's) because this loader answers
  // "what should this deployment show?", matching lib/dashboard/practice-metrics
  // and lib/billing/session-payment-eligibility. Read-only: prepare and execute
  // remain the authoritative money path and are untouched.
  let attemptsUntrusted = false;
  const attemptsByAppt = new Map<string, AttemptRow[]>();
  const sessionIds = [...sessionToAppt.keys()];
  if (sessionIds.length > 0) {
    const { data: attemptRows, error: attemptError } = await supabase
      .from("payment_charge_attempts")
      .select("session_id, status, refund_status")
      .eq("studio_id", studioId)
      .eq("charge_reason", "session_payment")
      .eq("stripe_livemode", inferStripeLivemode())
      .in("session_id", sessionIds);
    if (attemptError) attemptsUntrusted = true;
    for (const a of (attemptRows ?? []) as Array<{
      session_id: string;
      status: string | null;
      refund_status: string | null;
    }>) {
      const apptId = sessionToAppt.get(a.session_id);
      if (!apptId) continue;
      const bucket = attemptsByAppt.get(apptId) ?? [];
      bucket.push({ status: a.status, refund_status: a.refund_status });
      attemptsByAppt.set(apptId, bucket);
    }
  }

  const transactionStateTrusted = !sessionError && !attemptsUntrusted;

  // Reviews 3779063521 / 3779063523. THREE STAGES, and only trusted facts are
  // ever combined. Query-error awareness lives HERE, at the I/O boundary; the
  // pure reducer below stays free of Supabase concepts.
  //
  //   1. transaction truth , if either read failed we cannot know whether a
  //      pending / succeeded / refunded attempt exists, so every appointment is
  //      unavailable. Never assume absence.
  //   2. terminal states win: money that has actually moved outranks pricing,
  //      so a known Processing / Paid / Refunded is preserved even when the
  //      price cannot be loaded. The unavailable state is only for facts that
  //      genuinely depend on the failed read.
  //   3. pricing truth     : for the remaining appointments the answer depends
  //      on the price, so a failed pricing read is unavailable rather than a
  //      confident "chargeable".
  if (!transactionStateTrusted) {
    for (const apptId of ids) out.set(apptId, "unavailable");
    return out;
  }

  const freeLoad = await getFreeAppointmentIds(studioId, ids, studioTimezone);

  for (const apptId of ids) {
    const hasSession = apptHasSession.has(apptId);
    const attempts = attemptsByAppt.get(apptId) ?? [];
    // Stage 2: resolved WITHOUT freeness, purely to see whether transaction
    // truth already settles this appointment.
    const transactionOnly = deriveAppointmentPaymentState(
      hasSession,
      attempts,
      false,
    );
    if (
      transactionOnly === "paid" ||
      transactionOnly === "refunded" ||
      transactionOnly === "processing"
    ) {
      out.set(apptId, transactionOnly);
      continue;
    }
    // Stage 3: everything left depends on the current price.
    if (!freeLoad.ok) {
      out.set(apptId, "unavailable");
      continue;
    }
    out.set(
      apptId,
      deriveAppointmentPaymentState(
        hasSession,
        attempts,
        freeLoad.freeAppointmentIds.has(apptId),
      ),
    );
  }

  return out;
}

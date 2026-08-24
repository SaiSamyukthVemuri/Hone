import "server-only";
import { createClient } from "@/lib/supabase/server";
import { todayInTz } from "@/lib/booking/tz";
import { getSessionPaymentEligibility } from "@/lib/billing/session-payment-eligibility";
import { getAuthoritativeSessionPaymentAmount } from "@/lib/billing/authoritative-session-payment";
import type { SessionPaymentAmountResult } from "@/lib/billing/session-payment-amount";
import type { SessionPaymentEligibility } from "@/lib/billing/session-payment-types";
import {
  getAppointmentSettlements,
  resolveAppointmentQuotedAmountCents,
} from "@/lib/billing/appointment-settlement";
import type { SettlementMethod } from "@/lib/billing/settlement-types";

// Quick checkout (Chloe feedback: checkout takes too many clicks while the client
// is waiting). This resolver is the ONLY new server logic: it turns an
// APPOINTMENT into the exact same eligibility + authoritative-amount decision the
// session detail page uses, so the quick-checkout modal can render the
// existing SessionPaymentPrepareCard and drive the existing prepare/execute/
// receipt/refund server actions UNCHANGED. It never charges, never writes, and
// never touches clinical state.
//
// The whole payment path is SESSION-scoped (a charge attaches to a session linked
// to a completed appointment). So checkout requires a session; if none exists the
// resolver returns an ineligible result pointing the practitioner at the existing
// charting workflow (it never invents a hidden clinical session).

/**
 * APPOINTMENT SETTLEMENT CONTEXT — deliberately SEPARATE from the
 * session-dependent card-charge context below it.
 *
 * THE DEFECT THIS SEPARATION FIXES. Everything a practitioner could do about
 * money used to hang off `ok: true`, and `ok: true` requires a treatment
 * session, because a CARD CHARGE requires one (the amount comes off the
 * treatment record). So a completed visit that was never charted returned
 * `ok: false` with "go and chart first" — and the settlement controls, which
 * need no session at all, went with it. The schema was anchored on the
 * appointment precisely so cash would not require charting; the UI still
 * required it, which defeated the point.
 *
 * A missing session may legitimately block CARD CHARGING. It must never block
 * recording that the client paid cash. These are two different questions and
 * they now have two different answers.
 *
 * No fake session is manufactured, and no charting requirement is weakened.
 */
export type AppointmentSettlementContext = {
  appointmentId: string;
  /**
   * Whether a disposition may be recorded at all. Only a COMPLETED appointment
   * can carry one — the 0187 commands refuse anything else with
   * `not_completed`, and this is the UI's copy of that same rule.
   */
  canRecord: boolean;
  /** The live attested disposition, when one exists. */
  settledMethod: SettlementMethod | null;
  settledAmountCents: number | null;
  /**
   * The authoritative price, resolved from the APPOINTMENT so it is available
   * with no session. Pre-fills the amount; the action re-resolves and snapshots
   * it server-side regardless.
   */
  quotedAmountCents: number | null;
};

export type QuickCheckoutContext =
  | {
      ok: true;
      sessionId: string;
      clientId: string;
      clientName: string;
      appointment: {
        id: string;
        status: string | null;
        startsAt: string | null;
        serviceName: string | null;
      };
      eligibility: SessionPaymentEligibility;
      amountResult: SessionPaymentAmountResult | null;
      settlement: AppointmentSettlementContext;
    }
  | {
      ok: false;
      // A safe, practitioner-facing reason. clientId is included when known so
      // the modal can link to the existing charting workflow.
      reason: string;
      clientId: string | null;
      // PRESENT EVEN HERE. The card path being unavailable is not a reason to
      // withhold the honest alternative — it is the main reason to offer it.
      // Null only when the appointment itself could not be resolved, in which
      // case there is nothing to attest about.
      settlement: AppointmentSettlementContext | null;
    };

type Args = {
  studioId: string;
  studioTimezone: string;
  appointmentId: string;
};

export async function resolveQuickCheckoutContext(
  args: Args,
): Promise<QuickCheckoutContext> {
  const supabase = await createClient();

  // 1) Appointment, studio-scoped (RLS + explicit .eq). No client-supplied
  //    studio/amount/status is trusted; everything is read from the row.
  const { data: appt } = await supabase
    .from("appointments")
    .select(
      "id, studio_id, status, starts_at, duration_minutes, client_id, service_id, client:clients(name), service:services(name, price_cents)",
    )
    .eq("studio_id", args.studioId)
    .eq("id", args.appointmentId)
    .maybeSingle();

  if (!appt) {
    return {
      ok: false,
      reason: "Appointment not found in this studio.",
      clientId: null,
      settlement: null,
    };
  }

  const clientId = (appt.client_id as string | null) ?? null;
  const clientEmbed = (appt as { client?: unknown }).client;
  const clientObj = (Array.isArray(clientEmbed) ? clientEmbed[0] : clientEmbed) as
    | { name?: string | null }
    | null;
  const clientName = clientObj?.name?.trim() || "Client";
  const svcEmbed = (appt as { service?: unknown }).service;
  const svcObj = (Array.isArray(svcEmbed) ? svcEmbed[0] : svcEmbed) as
    | { name?: string | null; price_cents?: number | null }
    | null;

  // 2) THE SETTLEMENT CONTEXT, resolved FIRST and independently of any session.
  //    Everything below this point is about the CARD path.
  //
  //    A failed settlement read is not "nothing is settled": offering to record
  //    an outcome over one that already exists would have the practitioner type
  //    an amount only to be refused with already_settled. Refuse up front and
  //    say so, for the same reason the free-visit loader refuses to infer.
  const settlements = await getAppointmentSettlements(args.studioId, [
    args.appointmentId,
  ]);
  if (!settlements.ok) {
    return {
      ok: false,
      reason:
        "We could not load this appointment's payment status. Reload and try again.",
      clientId,
      settlement: null,
    };
  }
  const live = settlements.byAppointmentId.get(args.appointmentId) ?? null;
  const apptStatus = (appt.status as string | null) ?? null;
  const settlement: AppointmentSettlementContext = {
    appointmentId: args.appointmentId,
    // The UI's copy of the database's own rule (`not_completed`).
    canRecord: apptStatus === "completed",
    settledMethod: live?.method ?? null,
    settledAmountCents: live?.amountCents ?? null,
    quotedAmountCents: await resolveAppointmentQuotedAmountCents(
      args.studioId,
      args.appointmentId,
      args.studioTimezone,
    ),
  };

  // 3) The treatment session for this appointment. THE CARD PATH is
  //    session-scoped; if there is no session yet, card charging is genuinely
  //    unavailable and the practitioner is told why — but the settlement
  //    context above travels with the refusal, so cash is still recordable.
  const { data: sessionRow } = await supabase
    .from("sessions")
    .select("id")
    .eq("studio_id", args.studioId)
    .eq("appointment_id", args.appointmentId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (!sessionRow) {
    return {
      ok: false,
      reason:
        "No treatment session for this appointment yet, so a card charge is not available. Open the client's session to start charting, or record how the visit was settled below.",
      clientId,
      settlement,
    };
  }
  const sessionId = sessionRow.id as string;

  // 3) Reuse the EXACT eligibility + default-amount helpers the session page uses
  //    (unchanged). Eligibility carries the blocking reasons (not completed, no
  //    card, already-active-attempt, etc.) the card renders.
  const eligibility = await getSessionPaymentEligibility({
    studioId: args.studioId,
    sessionId,
  });

  // F-PAY-001: quick checkout does NOT reconstruct pricing. It calls the same
  // trusted server loader the session-detail card and the prepare action use,
  // so the two surfaces cannot disagree about the amount or its source.
  const priced = await getAuthoritativeSessionPaymentAmount({
    studioId: args.studioId,
    sessionId,
    studioTimezone: args.studioTimezone,
  });
  const amountResult = priced.ok ? priced.result : null;

  return {
    ok: true,
    sessionId,
    clientId: clientId ?? (eligibility.client?.id ?? ""),
    clientName,
    appointment: {
      id: appt.id as string,
      status: (appt.status as string | null) ?? null,
      startsAt: (appt.starts_at as string | null) ?? null,
      serviceName: svcObj?.name ?? null,
    },
    eligibility,
    amountResult,
    settlement,
  };
}

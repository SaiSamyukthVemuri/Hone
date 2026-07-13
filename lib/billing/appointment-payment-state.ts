import "server-only";
import { createClient } from "@/lib/supabase/server";

// Bounded, tenant-scoped batch loader for the dashboard/calendar checkout cell:
// given the visible appointment ids, return each appointment's coarse
// session_payment state WITHOUT an N+1. Two bounded queries total — sessions by
// appointment id, then attempts by session id — never a per-row lookup and never
// the full payment history. Read-only; no Stripe, no writes.

export type AppointmentPaymentState =
  | "paid"
  | "processing"
  | "refunded"
  | "chargeable" // has a session, no terminal charge yet (or a retryable failure)
  | "no_session"; // no treatment session for the appointment yet

type AttemptRow = { status: string | null; refund_status: string | null };

// Pure reducer: the strongest terminal state wins (paid/refunded > processing >
// chargeable). Exported for unit testing without a database.
export function deriveAppointmentPaymentState(
  hasSession: boolean,
  attempts: ReadonlyArray<AttemptRow>,
): AppointmentPaymentState {
  if (!hasSession) return "no_session";
  let processing = false;
  for (const a of attempts) {
    if (a.status === "succeeded") {
      return a.refund_status === "succeeded" ? "refunded" : "paid";
    }
    if (a.status === "pending_stripe") processing = true;
  }
  if (processing) return "processing";
  return "chargeable";
}

export async function getAppointmentPaymentStates(
  studioId: string,
  appointmentIds: ReadonlyArray<string>,
): Promise<Map<string, AppointmentPaymentState>> {
  const out = new Map<string, AppointmentPaymentState>();
  const ids = [...new Set(appointmentIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const supabase = await createClient();

  // 1) Sessions for these appointments (studio-scoped + RLS). One bounded query.
  const { data: sessionRows } = await supabase
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
  const attemptsByAppt = new Map<string, AttemptRow[]>();
  const sessionIds = [...sessionToAppt.keys()];
  if (sessionIds.length > 0) {
    const { data: attemptRows } = await supabase
      .from("payment_charge_attempts")
      .select("session_id, status, refund_status")
      .eq("studio_id", studioId)
      .eq("charge_reason", "session_payment")
      .in("session_id", sessionIds);
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

  for (const apptId of ids) {
    out.set(
      apptId,
      deriveAppointmentPaymentState(
        apptHasSession.has(apptId),
        attemptsByAppt.get(apptId) ?? [],
      ),
    );
  }
  return out;
}

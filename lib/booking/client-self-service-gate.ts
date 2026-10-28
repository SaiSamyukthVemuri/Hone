import "server-only";

import type { ClientSelfServicePolicy } from "@/lib/booking/client-self-service-policy";
import { loadClientSelfServicePolicy } from "@/lib/booking/client-self-service-policy-store";

// HON-47. The token routes (/cancel, /reschedule, /manage) resolve a token to
// an appointment id and then ask ONE question here: what does this
// appointment's studio allow its clients to do online?
//
// `live` keeps the existing collapse rule intact. A refusal that names the
// policy ("online cancellation isn't available, your appointment is still
// booked") is only truthful, and only shown, for a FUTURE CONFIRMED appointment.
// Every other token state keeps answering with the route's generic copy, so the
// policy message never becomes a token-state signal.
//
// FAIL CLOSED: an unreadable appointment or policy is `ok: false`, and the
// caller answers with its generic copy and mutates nothing.

type AppointmentReader = {
  from(table: "appointments"): {
    select(columns: "studio_id, status, starts_at"): {
      eq(
        column: "id",
        value: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: { studio_id: string; status: string; starts_at: string } | null;
          error: { code?: string | null } | null;
        }>;
      };
    };
  };
};

export type AppointmentSelfServiceGate =
  | {
      ok: true;
      policy: ClientSelfServicePolicy;
      studioName: string | null;
      live: boolean;
    }
  | { ok: false };

export async function loadAppointmentSelfServiceGate(
  admin: unknown,
  appointmentId: string,
): Promise<AppointmentSelfServiceGate> {
  const { data, error } = await (admin as AppointmentReader)
    .from("appointments")
    .select("studio_id, status, starts_at")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error || !data) return { ok: false };

  const read = await loadClientSelfServicePolicy(admin, data.studio_id);
  if (!read.ok) return { ok: false };

  const startsAtMs = new Date(data.starts_at).getTime();
  return {
    ok: true,
    policy: read.policy,
    studioName: read.studioName,
    live:
      data.status === "confirmed" &&
      Number.isFinite(startsAtMs) &&
      startsAtMs > Date.now(),
  };
}

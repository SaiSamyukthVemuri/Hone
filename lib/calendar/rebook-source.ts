import "server-only";

import { dbErrorCode } from "@/lib/logging/error-class";
import { isAppointmentUuid } from "@/lib/sessions/session-start-refusal";
import { createClient } from "@/lib/supabase/server";

export type CalendarRebookSource = {
  clientId: string;
  serviceId: string;
  durationMinutes: number;
  practitionerId: string | null;
};

// The link carries only the source appointment. Resolve booking defaults against
// the signed-in calendar's studio, including the active client and service.
export async function getCalendarRebookSource(
  studioId: string,
  appointmentId: string | undefined,
): Promise<CalendarRebookSource | null> {
  if (!isAppointmentUuid(appointmentId)) return null;

  const db = await createClient();
  const { data, error } = await db
    .from("appointments")
    .select("client_id, service_id, duration_minutes, practitioner_id, client:clients!inner(id), service:services!inner(id)")
    .eq("studio_id", studioId)
    .eq("id", appointmentId)
    .eq("client.studio_id", studioId)
    .is("client.archived_at", null)
    .eq("service.studio_id", studioId)
    .eq("service.active", true)
    .maybeSingle();

  if (error) throw new Error(`Calendar rebook lookup failed: ${dbErrorCode(error)}`);
  if (!data?.service_id || !data.client_id) return null;
  return {
    clientId: data.client_id,
    serviceId: data.service_id,
    durationMinutes: data.duration_minutes,
    practitionerId: data.practitioner_id,
  };
}

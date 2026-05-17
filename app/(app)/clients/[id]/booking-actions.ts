"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAvailableSlots, type Slot } from "@/lib/booking/slots";

export async function fetchSlotsForClientBookingAction(params: {
  serviceId: string;
  date: string;
}): Promise<{ ok: true; slots: Slot[] } | { ok: false; error: string }> {
  if (!params.serviceId || !params.date) {
    return { ok: false, error: "Pick a service and date." };
  }

  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  const { data: service, error: serviceErr } = await supabase
    .from("services")
    .select("default_duration_minutes")
    .eq("id", params.serviceId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (serviceErr) return { ok: false, error: serviceErr.message };
  if (!service) return { ok: false, error: "Service not found." };

  const slots = await getAvailableSlots(
    supabase,
    {
      id: studio.id,
      timezone: studio.timezone,
      default_appointment_duration_minutes:
        studio.default_appointment_duration_minutes,
      buffer_minutes: studio.buffer_minutes,
    },
    params.date,
    service.default_duration_minutes,
  );
  return { ok: true, slots };
}

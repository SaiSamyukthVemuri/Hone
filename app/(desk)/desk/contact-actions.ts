"use server";

import { validDeskId, type DeskResult } from "@/lib/desk/booking";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import { createClient } from "@/lib/supabase/server";

export async function getDeskAppointmentContactAction(input: {
  studioId: string; appointmentId: string;
}): Promise<DeskResult<{ phone: string | null; email: string | null }>> {
  const { studioId } = await requireReceptionistWithStudio();
  if (input?.studioId !== studioId) return { ok: false, error: "Your selected studio changed. Reload the calendar." };
  const unavailable = { ok: false, error: "Contact details are unavailable for this appointment." } as const;
  if (!validDeskId(input.appointmentId)) return unavailable;
  try {
    const db = await createClient();
    const { data, error } = await db.rpc("receptionist_appointment_contact", {
      p_studio_id: studioId, p_appointment_id: input.appointmentId,
    });
    if (error || !Array.isArray(data) || data.length !== 1 || !data[0]) return unavailable;
    const { phone, email } = data[0];
    if ((phone !== null && typeof phone !== "string") || (email !== null && typeof email !== "string")) return unavailable;
    return { ok: true, phone: phone?.trim() || null, email: email?.trim() || null };
  } catch {
    return unavailable;
  }
}

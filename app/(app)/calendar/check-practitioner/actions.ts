"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { dbErrorCode } from "@/lib/logging/error-class";

// OWNER-ONLY BY DESIGN (see page.tsx): a configurable staff "reassign" permission must not reach this action.
// Sam 1 Nov: an existing assignment changes ONLY when the owner explicitly confirms a correction, and the
// change is audited (the command writes a 'reassigned' audit row with the previous and new practitioner:
// 0220 move_appointment_core). No client email is sent: this corrects an internal record, the time is unchanged.

export type CheckReassignResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reassignOpenAppointmentAction(formData: FormData): Promise<CheckReassignResult> {
  const appointmentId = String(formData.get("appointment_id") ?? "").trim();
  const targetId = String(formData.get("target_practitioner_id") ?? "").trim();
  if (!UUID.test(appointmentId) || !UUID.test(targetId)) return { ok: false, error: "Invalid request." };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner" || practitioner.active !== true) {
    return { ok: false, error: "Only the studio owner can change an appointment's practitioner." };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select("id, status, starts_at, ends_at, practitioner_id")
    .eq("id", appointmentId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.status !== "confirmed") return { ok: false, error: "This appointment is no longer open. Refresh the page to see its current state." };
  if (appt.practitioner_id === targetId) return { ok: false, error: "That practitioner is already recorded." };
  if (new Date(appt.starts_at as string).getTime() <= Date.now()) {
    // The reviewed command only covers appointments whose time has not come. A past-date, unfinished one needs
    // a separately reviewed command that does not exist yet; nothing is changed. (A past date is not a recorded
    // treatment start, so the wording does not claim the visit began.)
    return {
      ok: false,
      error: "This appointment's date has passed, so its practitioner is not changed here. Refresh the page to see its current state, or open the appointment to complete it.",
    };
  }

  // A linked live session is the record that treatment began, whatever the date. Re-read it here (the page's phase can be
  // stale, or the request hand-made): reassigning would make the appointment's practitioner disagree with the chart's performer.
  // A failed read refuses (fail closed).
  const { count: sessionCount, error: sessionErr } = await admin
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("appointment_id", appointmentId)
    .eq("studio_id", studio.id)
    .is("deleted_at", null);
  if (sessionErr) return { ok: false, error: "We couldn't check this appointment. Please try again." };
  if ((sessionCount ?? 0) > 0) {
    return {
      ok: false,
      error: "A treatment record now exists for this appointment, so its practitioner is not changed here. Refresh the page to see its current state, or open the appointment.",
    };
  }

  // The command skips the target's active check for an owner actor in a capacity-OFF studio (0220, 0152), so the
  // dropdown is not enough: check on the server that the target is an ACTIVE practitioner of THIS studio.
  const { data: target } = await admin
    .from("practitioners")
    .select("id, active")
    .eq("id", targetId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (!target || target.active !== true) {
    return { ok: false, error: "That practitioner isn't available for this appointment." };
  }

  const { data: rows, error } = await admin.rpc("move_or_reassign_appointment", {
    p_appointment_id: appointmentId,
    p_studio_id: studio.id,
    p_actor_practitioner_id: practitioner.id,
    p_target_practitioner_id: targetId,
    p_expected_starts_at: appt.starts_at,
    p_expected_ends_at: appt.ends_at,
    p_new_starts_at: appt.starts_at, // unchanged: a reassignment, not a move
    p_allow_outside_availability: false,
  });
  if (error) {
    console.error(JSON.stringify({ event: "check_practitioner_reassign_rpc_error", code: dbErrorCode(error) }));
    return { ok: false, error: "We couldn't change the practitioner. Please try again." };
  }
  const row = (Array.isArray(rows) ? rows[0] : rows) as { result?: string } | undefined;
  switch (row?.result) {
    case "reassigned":
      revalidatePath("/calendar/check-practitioner");
      revalidatePath("/calendar");
      return { ok: true };
    case "invalid_practitioner":
    case "not_eligible":
      return { ok: false, error: "That practitioner isn't available for this appointment." };
    case "stale_appointment":
      return { ok: false, error: "This appointment changed in another window. Refresh and try again." };
    case "not_authorized":
      return { ok: false, error: "You're not allowed to change this appointment." };
    case "appointment_not_movable":
      return { ok: false, error: "This appointment is no longer open." };
    case "outside_availability":
    case "practitioner_closed":
      return { ok: false, error: "That practitioner isn't working at this appointment's time. Choose another practitioner." };
    case "booking_paused":
      return { ok: false, error: "Changes are paused for this studio right now." };
    default:
      return { ok: false, error: "We couldn't change the practitioner. Please try again." };
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAvailableSlots, filterFutureSlots } from "@/lib/booking/slots";
import { utcInstantFromLocal } from "@/lib/booking/tz";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { notifyAppointmentMoved, type MoveNotificationStatus } from "@/lib/email/notify-appointment-moved";

// Practitioner Move appointment — the ONE shared backend workflow used by mobile,
// tablet and desktop. Two typed server actions:
//   * loadMoveSlotsAction  — authorized available times for the SAME appointment
//     (own-reservation excluded server-side; every other conflict still applies).
//   * moveAppointmentAction — the atomic same-record move via the 0133 RPC.
// Both resolve practitioner + studio SERVER-SIDE via getCurrentPractitionerWithStudio
// (which requires an active practitioner) and NEVER trust a browser-supplied studio_id
// or practitioner_id. The admin (service-role) client is used only after that resolve.

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
function isValidInstant(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && !Number.isNaN(new Date(s).getTime());
}

export type MoveSlot = { start: string; end: string; label: string };
export type LoadMoveSlotsResult = { ok: true; slots: MoveSlot[] } | { ok: false; error: string };

export async function loadMoveSlotsAction(input: {
  appointmentId: string;
  localDate: string;
}): Promise<LoadMoveSlotsResult> {
  const appointmentId = typeof input?.appointmentId === "string" ? input.appointmentId : "";
  const localDate = typeof input?.localDate === "string" ? input.localDate : "";
  if (!UUID_RE.test(appointmentId) || !DATE_RE.test(localDate)) {
    return { ok: false, error: "Invalid request." };
  }

  // Resolve the studio server-side (this also asserts an active practitioner membership).
  const { studio } = await getCurrentPractitionerWithStudio();
  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();

  const { data: appt } = await admin
    .from("appointments")
    .select("id, studio_id, status, starts_at, duration_minutes")
    .eq("id", appointmentId)
    .eq("studio_id", studio.id) // server-resolved studio; browser cannot widen the boundary
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.status !== "confirmed" || new Date(appt.starts_at).getTime() <= Date.now()) {
    return { ok: false, error: "This appointment can no longer be moved." };
  }

  const slots = await getAvailableSlots(
    admin,
    {
      id: studio.id,
      timezone: studio.timezone,
      default_appointment_duration_minutes: studio.default_appointment_duration_minutes,
      buffer_minutes: studio.buffer_minutes,
    },
    localDate,
    appt.duration_minutes, // use the appointment's EXISTING duration
    { sourceKind: "appointment", sourceId: appointmentId }, // exclude ONLY this appointment's own reservation
  );
  // Never propose a past instant; return a PHI-free list (no client/notes/token/provider data).
  return {
    ok: true,
    slots: filterFutureSlots(slots).map((s) => ({ start: s.start, end: s.end, label: s.startLabel })),
  };
}

export type MoveAppointmentResult =
  | {
      ok: true;
      appointmentId: string;
      startsAt: string;
      endsAt: string;
      notificationStatus: MoveNotificationStatus;
      message: string;
    }
  | { ok: false; error: string; code?: "conflict" | "stale" | "no_change" };

export async function moveAppointmentAction(input: {
  appointmentId: string;
  expectedStartsAt: string;
  expectedEndsAt: string;
  localDate: string;
  localTime: string;
}): Promise<MoveAppointmentResult> {
  const appointmentId = typeof input?.appointmentId === "string" ? input.appointmentId : "";
  const { expectedStartsAt, expectedEndsAt, localDate, localTime } = input ?? {};
  if (
    !UUID_RE.test(appointmentId) ||
    !isValidInstant(expectedStartsAt) ||
    !isValidInstant(expectedEndsAt) ||
    typeof localDate !== "string" || !DATE_RE.test(localDate) ||
    typeof localTime !== "string" || !TIME_RE.test(localTime)
  ) {
    return { ok: false, error: "Invalid request." };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();

  const { data: appt } = await admin
    .from("appointments")
    .select("id, status, starts_at, client_id")
    .eq("id", appointmentId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.status !== "confirmed" || new Date(appt.starts_at).getTime() <= Date.now()) {
    return { ok: false, error: "This appointment can no longer be moved." };
  }

  // §7.6: resolve + validate the required app origin BEFORE the mutation, so a bad
  // deployment origin cannot turn a committed move into a post-commit false failure.
  let appOrigin: string;
  try {
    appOrigin = getRequiredAppOrigin();
  } catch {
    return { ok: false, error: "We couldn't move the appointment. Please try again." };
  }

  // §7.7-8: convert the STUDIO-LOCAL date+time to a UTC instant using the studio tz.
  // Never the browser timezone. utcInstantFromLocal handles DST.
  const newStart = utcInstantFromLocal(localDate, localTime, studio.timezone);
  if (Number.isNaN(newStart.getTime()) || newStart.getTime() <= Date.now()) {
    return { ok: false, error: "Choose a valid future time." };
  }

  const { data: rows, error } = await admin.rpc("practitioner_move_appointment", {
    p_appointment_id: appointmentId,
    p_studio_id: studio.id,
    p_practitioner_id: practitioner.id,
    p_expected_starts_at: expectedStartsAt,
    p_expected_ends_at: expectedEndsAt,
    p_new_starts_at: newStart.toISOString(),
  });

  if (error) {
    // §7.11: an exclusion violation (double-book / block / break / blockout) -> safe conflict copy.
    if ((error as { code?: string }).code === "23P01") {
      return { ok: false, code: "conflict", error: "That time is no longer available. Choose another time." };
    }
    // Never surface raw Postgres/Supabase/RPC detail; log a PHI-free structured line.
    console.error(JSON.stringify({ event: "move_appointment_rpc_error", code: (error as { code?: string }).code ?? null }));
    return { ok: false, error: "We couldn't move the appointment. Please try again." };
  }

  const row = (Array.isArray(rows) ? rows[0] : rows) as
    | { result: string; new_starts_at: string; new_ends_at: string }
    | undefined;
  switch (row?.result) {
    case "moved":
      break;
    case "no_change":
      return { ok: false, code: "no_change", error: "Choose a different appointment time." };
    case "stale_appointment":
      return { ok: false, code: "stale", error: "This appointment changed in another window. Refresh and try again." };
    case "not_authorized":
      return { ok: false, error: "You're not allowed to move this appointment." };
    case "appointment_not_found":
      return { ok: false, error: "Appointment not found." };
    case "appointment_not_movable":
      return { ok: false, error: "This appointment can no longer be moved." };
    case "invalid_time":
      return { ok: false, error: "Choose a valid future time." };
    default:
      return { ok: false, error: "We couldn't move the appointment. Please try again." };
  }

  // Committed. Notify the client AFTER commit (best-effort, fail-open). A notification
  // failure NEVER reports the move as failed.
  const notificationStatus = await notifyAppointmentMoved(admin, {
    appointmentId,
    studioId: studio.id,
    appOrigin,
  });

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  revalidatePath(`/calendar/${appointmentId}`);
  if (appt.client_id) revalidatePath(`/clients/${appt.client_id}`);
  revalidatePath("/dashboard");

  return {
    ok: true,
    appointmentId,
    startsAt: row.new_starts_at,
    endsAt: row.new_ends_at,
    notificationStatus,
    message:
      notificationStatus === "degraded"
        ? "Appointment moved, but the client notification could not be delivered."
        : "Appointment moved.",
  };
}

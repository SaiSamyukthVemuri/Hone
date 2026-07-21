"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAvailableSlots, filterFutureSlots } from "@/lib/booking/slots";
import { utcInstantFromLocal, localTimeString } from "@/lib/booking/tz";
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
export type LoadMoveSlotsResult =
  | { ok: true; slots: MoveSlot[]; canUseCustomTime: boolean }
  | { ok: false; error: string };

// The StudioRow the slot generator needs — always built from the SERVER-resolved
// studio, never from anything the browser sent.
function studioRow(studio: {
  id: string;
  timezone: string;
  default_appointment_duration_minutes: number;
  buffer_minutes: number;
  practitioner_capacity_enabled?: boolean;
}) {
  return {
    id: studio.id,
    timezone: studio.timezone,
    default_appointment_duration_minutes: studio.default_appointment_duration_minutes,
    buffer_minutes: studio.buffer_minutes,
    // Part 4: needed so getAvailableSlots computes PER-PRACTITIONER slots for the
    // move target. Undefined/false keeps today's studio-wide behaviour (Legacy).
    practitioner_capacity_enabled: studio.practitioner_capacity_enabled,
  };
}

export async function loadMoveSlotsAction(input: {
  appointmentId: string;
  localDate: string;
}): Promise<LoadMoveSlotsResult> {
  const appointmentId = typeof input?.appointmentId === "string" ? input.appointmentId : "";
  const localDate = typeof input?.localDate === "string" ? input.localDate : "";
  if (!UUID_RE.test(appointmentId) || !DATE_RE.test(localDate)) {
    return { ok: false, error: "Invalid request." };
  }

  // Resolve the practitioner + studio server-side (also asserts an active membership).
  // canUseCustomTime is derived ONLY from the live server-resolved role; the browser
  // never supplies isOwner/role/studioId. The UI may use this flag solely to decide
  // whether to SHOW the custom-time option — the server action re-authorizes on submit.
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const canUseCustomTime = practitioner.role === "owner";
  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();

  const { data: appt } = await admin
    .from("appointments")
    .select("id, studio_id, status, starts_at, duration_minutes, practitioner_id")
    .eq("id", appointmentId)
    .eq("studio_id", studio.id) // server-resolved studio; browser cannot widen the boundary
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.status !== "confirmed" || new Date(appt.starts_at).getTime() <= Date.now()) {
    return { ok: false, error: "This appointment can no longer be moved." };
  }

  const slots = await getAvailableSlots(
    admin,
    studioRow(studio),
    localDate,
    appt.duration_minutes, // use the appointment's EXISTING duration
    { sourceKind: "appointment", sourceId: appointmentId }, // exclude ONLY this appointment's own reservation
    // Part 4: the move surface is time-only, so slots are the CURRENT
    // practitioner's availability — A's appointment never removes B's slot.
    appt.practitioner_id,
  );
  // Never propose a past instant; return a PHI-free list (no client/notes/token/provider data).
  return {
    ok: true,
    slots: filterFutureSlots(slots).map((s) => ({ start: s.start, end: s.end, label: s.startLabel })),
    canUseCustomTime,
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

// Move mode is a CLOSED contract. "available_slot" is the default: the target
// must be one of the currently generated available slots (verified server-side —
// browser state is not proof). "custom_time" is an OWNER-ONLY override that may be
// outside published operating hours but still cannot bypass any real reservation.
export type MoveMode = "available_slot" | "custom_time";

export async function moveAppointmentAction(input: {
  appointmentId: string;
  expectedStartsAt: string;
  expectedEndsAt: string;
  localDate: string;
  localTime: string;
  mode: MoveMode;
  outsideAvailabilityConfirmed: boolean;
}): Promise<MoveAppointmentResult> {
  const appointmentId = typeof input?.appointmentId === "string" ? input.appointmentId : "";
  const { expectedStartsAt, expectedEndsAt, localDate, localTime } = input ?? {};
  const mode = input?.mode;
  // NEVER accept role/isOwner/canUseCustomTime/allowOutsideAvailability/studioId/
  // practitionerId/duration/endTime as browser authority — none are read here.
  // outsideAvailabilityConfirmed is a user ACKNOWLEDGEMENT only; the owner ROLE is
  // re-checked server-side below.
  const outsideAvailabilityConfirmed = input?.outsideAvailabilityConfirmed === true;
  // Strictly reject an unknown mode (closed set).
  if (mode !== "available_slot" && mode !== "custom_time") {
    return { ok: false, error: "Invalid request." };
  }
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
    .select("id, status, starts_at, client_id, duration_minutes, practitioner_id")
    .eq("id", appointmentId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.status !== "confirmed" || new Date(appt.starts_at).getTime() <= Date.now()) {
    return { ok: false, error: "This appointment can no longer be moved." };
  }

  // §9: custom-time mode is an OWNER-ONLY override, authorized on the LIVE
  // server-resolved role, and requires the explicit override acknowledgement.
  // These gates run BEFORE any mutation.
  if (mode === "custom_time") {
    if (practitioner.role !== "owner") {
      return { ok: false, error: "Only the studio owner can move appointments outside regular availability." };
    }
    if (!outsideAvailabilityConfirmed) {
      return { ok: false, error: "Confirm that you want to override regular availability." };
    }
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

  // §8: available-slot mode MUST match a currently-offered generated slot. The
  // slot list is recomputed server-side (same studio/duration/own-exclusion as
  // loadMoveSlotsAction) and matched by START INSTANT — a crafted request that was
  // never offered cannot reach the RPC. Custom mode intentionally skips this so the
  // owner can pick a studio-local time outside published operating hours.
  if (mode === "available_slot") {
    const offered = filterFutureSlots(
      await getAvailableSlots(
        admin,
        studioRow(studio),
        localDate,
        appt.duration_minutes,
        { sourceKind: "appointment", sourceId: appointmentId },
        appt.practitioner_id, // Part 4: recheck against the CURRENT practitioner's slots
      ),
    );
    // Match by START INSTANT. Each offered slot is re-derived the SAME way the
    // client submits (slot -> studio-local HH:MM -> UTC), so a legitimately-offered
    // slot whose raw reservation-end anchor carries seconds is not falsely rejected,
    // while an arbitrary crafted time that maps to no offered slot is refused.
    const targetMs = newStart.getTime();
    const isOffered = offered.some(
      (s) =>
        utcInstantFromLocal(localDate, localTimeString(new Date(s.start), studio.timezone), studio.timezone).getTime() ===
        targetMs,
    );
    if (!isOffered) {
      return { ok: false, code: "conflict", error: "That time is no longer available. Choose another time." };
    }
  }

  // Part 4: route through the atomic move-or-reassign command (migration 0143),
  // which takes the shared capacity advisory lock and enforces the per-
  // practitioner authorization + booking-pause contract. This is a TIME-ONLY
  // move (target = the appointment's current practitioner); reassignment is a
  // separate owner-only surface. The legacy time-only RPC (0133) is no longer
  // called from the app, so there is no bypassable alternative.
  const { data: rows, error } = await admin.rpc("move_or_reassign_appointment", {
    p_appointment_id: appointmentId,
    p_studio_id: studio.id,
    p_actor_practitioner_id: practitioner.id,
    p_target_practitioner_id: appt.practitioner_id,
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
    case "reassigned":
    case "moved_and_reassigned":
      break; // time-only move surface never returns these, but honour them
    case "invalid_practitioner":
      return { ok: false, error: "That practitioner isn't available for this appointment." };
    case "not_eligible":
      return { ok: false, error: "That practitioner isn't set up for this service." };
    case "booking_paused":
      return { ok: false, error: "Changes are paused for this studio right now." };
    case "practitioner_reassignment_required":
      return {
        ok: false,
        error:
          "This appointment's practitioner is no longer active or eligible. Reassign it to an active practitioner to move it.",
      };
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

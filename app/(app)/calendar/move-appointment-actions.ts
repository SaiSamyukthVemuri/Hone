"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAvailableSlots,
  filterFutureSlots,
  INTERNAL_SLOT_PACKING,
} from "@/lib/booking/slots";
import { utcInstantFromLocal, localTimeString } from "@/lib/booking/tz";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { notifyAppointmentMoved, type MoveNotificationStatus } from "@/lib/email/notify-appointment-moved";

// Practitioner Move appointment: the ONE shared backend workflow used by mobile,
// tablet and desktop. Two typed server actions:
//   * loadMoveSlotsAction , authorized available times for the SAME appointment
//     (own-reservation excluded server-side; every other conflict still applies).
//   * moveAppointmentAction, the atomic same-record move via the 0133 RPC.
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
export type MovePractitionerOption = { id: string; displayName: string };
export type LoadMoveSlotsResult =
  | {
      ok: true;
      slots: MoveSlot[];
      canUseCustomTime: boolean;
      // Item 7: owner-only reassignment context. reassignEnabled is true only for
      // an owner of a capacity-ON studio; members + Legacy get an empty list and
      // reassignEnabled=false (time-only move, no selector). Display names only.
      reassignEnabled: boolean;
      eligiblePractitioners: MovePractitionerOption[];
      currentPractitionerId: string;
      // Whether the appointment's CURRENT practitioner is still active + eligible;
      // when false the owner must deliberately choose a replacement (no silent pick).
      currentPractitionerValid: boolean;
    }
  | { ok: false; error: string };

// Active, same-studio practitioners ELIGIBLE for the appointment's service. A NULL
// service (rare) means the command applies no eligibility filter, so mirror that:
// every active practitioner is a valid target. Returns null on a lookup error
// (fail closed). Display names only, never email / user id / metadata.
async function loadEligiblePractitioners(
  admin: SupabaseClient,
  studioId: string,
  serviceId: string | null,
): Promise<MovePractitionerOption[] | null> {
  let ids: string[] | null = null;
  if (serviceId) {
    const { data, error } = await admin
      .from("service_practitioners")
      .select("practitioner_id")
      .eq("service_id", serviceId)
      .eq("studio_id", studioId);
    if (error) return null; // fail closed
    ids = (data ?? []).map((r) => r.practitioner_id as string);
    if (ids.length === 0) return [];
  }
  const base = admin
    .from("practitioners")
    .select("id, display_name")
    .eq("studio_id", studioId)
    .eq("active", true);
  const { data, error } = ids ? await base.in("id", ids) : await base;
  if (error) return null; // fail closed
  return (data ?? [])
    .map((p) => ({ id: p.id as string, displayName: p.display_name as string }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// The StudioRow the slot generator needs, always built from the SERVER-resolved
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
  // Item 7: an owner may request slots for a PROPOSED reassignment target. Ignored
  // for members / Legacy. Validated server-side (active + same-studio + eligible).
  targetPractitionerId?: string | null;
}): Promise<LoadMoveSlotsResult> {
  const appointmentId = typeof input?.appointmentId === "string" ? input.appointmentId : "";
  const localDate = typeof input?.localDate === "string" ? input.localDate : "";
  const requestedTarget =
    typeof input?.targetPractitionerId === "string" && UUID_RE.test(input.targetPractitionerId)
      ? input.targetPractitionerId
      : null;
  if (!UUID_RE.test(appointmentId) || !DATE_RE.test(localDate)) {
    return { ok: false, error: "Invalid request." };
  }

  // Resolve the practitioner + studio server-side (also asserts an active membership).
  // canUseCustomTime is derived ONLY from the live server-resolved role; the browser
  // never supplies isOwner/role/studioId. The UI may use this flag solely to decide
  // whether to SHOW the custom-time option: the server action re-authorizes on submit.
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const canUseCustomTime = practitioner.role === "owner";
  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();

  const { data: appt } = await admin
    .from("appointments")
    .select("id, studio_id, status, starts_at, duration_minutes, practitioner_id, service_id")
    .eq("id", appointmentId)
    .eq("studio_id", studio.id) // server-resolved studio; browser cannot widen the boundary
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.status !== "confirmed" || new Date(appt.starts_at).getTime() <= Date.now()) {
    return { ok: false, error: "This appointment can no longer be moved." };
  }

  // Item 7 reassignment context: OWNER of a capacity-ON studio only. Members +
  // Legacy get no choices (reassignEnabled=false → time-only move, no selector).
  const reassignEnabled =
    practitioner.role === "owner" && studio.practitioner_capacity_enabled === true;
  let eligible: MovePractitionerOption[] = [];
  let currentValid = true;
  if (reassignEnabled) {
    const loaded = await loadEligiblePractitioners(admin, studio.id, appt.service_id ?? null);
    if (loaded === null) {
      return { ok: false, error: "Could not load practitioners. Please try again." }; // fail closed
    }
    eligible = loaded;
    currentValid = eligible.some((p) => p.id === appt.practitioner_id);
  }

  // Resolve the slot target. Owner + a requested target must be validated; an
  // unresolved target (current is inactive/ineligible + nothing chosen) yields NO
  // slots (reassignment is required, never a silent self/first fallback).
  let slotTarget: string | null = appt.practitioner_id;
  if (reassignEnabled) {
    if (requestedTarget) {
      if (!eligible.some((p) => p.id === requestedTarget)) {
        return { ok: false, error: "That practitioner isn't available." }; // fail closed, no enumeration
      }
      slotTarget = requestedTarget;
    } else if (!currentValid) {
      slotTarget = null; // reassignment required before any time can be offered
    }
  }

  const slots = slotTarget
    ? filterFutureSlots(
        await getAvailableSlots(
          admin,
          studioRow(studio),
          localDate,
          appt.duration_minutes, // use the appointment's EXISTING duration
          { sourceKind: "appointment", sourceId: appointmentId }, // exclude ONLY this appointment's own reservation
          slotTarget, // Part 4/Item 7: the CURRENT practitioner (time-only) OR the proposed target
          INTERNAL_SLOT_PACKING,
        ),
      ).map((s) => ({ start: s.start, end: s.end, label: s.startLabel }))
    : [];

  // Never propose a past instant; return a PHI-free list (no client/notes/token/provider data).
  return {
    ok: true,
    slots,
    canUseCustomTime,
    reassignEnabled,
    eligiblePractitioners: eligible,
    currentPractitionerId: appt.practitioner_id,
    currentPractitionerValid: currentValid,
  };
}

export type MoveResultKind = "moved" | "reassigned" | "moved_and_reassigned";
export type MoveAppointmentResult =
  | {
      ok: true;
      appointmentId: string;
      startsAt: string;
      endsAt: string;
      // Item 7: which operation actually committed, so the UI + client email are
      // truthful (a same-time reassignment is NOT a "time changed").
      resultKind: MoveResultKind;
      notificationStatus: MoveNotificationStatus;
      message: string;
    }
  | { ok: false; error: string; code?: "conflict" | "stale" | "no_change" };

// Move mode is a CLOSED contract. "available_slot" is the default: the target
// must be one of the currently generated available slots (verified server-side,
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
  // Item 7: an owner may propose a reassignment target. Ignored for members /
  // Legacy (resolved to NULL = time-only). Re-validated server-side below.
  targetPractitionerId?: string | null;
}): Promise<MoveAppointmentResult> {
  const appointmentId = typeof input?.appointmentId === "string" ? input.appointmentId : "";
  const { expectedStartsAt, expectedEndsAt, localDate, localTime } = input ?? {};
  const mode = input?.mode;
  const requestedTarget =
    typeof input?.targetPractitionerId === "string" && UUID_RE.test(input.targetPractitionerId)
      ? input.targetPractitionerId
      : null;
  // NEVER accept role/isOwner/canUseCustomTime/allowOutsideAvailability/studioId/
  // practitionerId/duration/endTime as browser authority, none are read here.
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
    .select("id, status, starts_at, client_id, duration_minutes, practitioner_id, service_id")
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

  // Item 7: resolve + REVALIDATE the reassignment target. Only an OWNER of a
  // capacity-ON studio may reassign, and only to an active, same-studio, service-
  // eligible practitioner that DIFFERS from the current one. Any other case
  // (member, Legacy, forged/ineligible id, or the same practitioner) resolves to
  // NULL = a time-only move that preserves the current practitioner. The DB
  // command re-validates the target independently.
  let target: string | null = null;
  const reassignEnabled =
    practitioner.role === "owner" && studio.practitioner_capacity_enabled === true;
  if (reassignEnabled && requestedTarget && requestedTarget !== appt.practitioner_id) {
    const eligible = await loadEligiblePractitioners(admin, studio.id, appt.service_id ?? null);
    if (eligible === null) {
      return { ok: false, error: "We couldn't move the appointment. Please try again." };
    }
    if (!eligible.some((p) => p.id === requestedTarget)) {
      return { ok: false, error: "That practitioner isn't available for this appointment." };
    }
    target = requestedTarget;
  }
  // The practitioner the slots must be validated against (reassignment target if
  // set, otherwise the appointment's current practitioner).
  const slotTarget = target ?? appt.practitioner_id;

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
  // loadMoveSlotsAction) and matched by START INSTANT: a crafted request that was
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
        slotTarget, // Item 7: recheck against the FINAL target (reassignment) or the current practitioner
        INTERNAL_SLOT_PACKING, // MUST match loadMoveSlotsAction, or an offered slot becomes unbookable
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
    // Item 7: an explicit validated target for an OWNER reassignment; NULL for a
    // time-only move (member / Legacy / owner keeping the same practitioner),
    // which preserves the current practitioner from the LOCKED row (0145). The
    // command re-validates the target and is the final authority.
    p_target_practitioner_id: target,
    p_expected_starts_at: expectedStartsAt,
    p_expected_ends_at: expectedEndsAt,
    p_new_starts_at: newStart.toISOString(),
    // Part 4 Item 4: custom_time IS the owner-only, acknowledgement-gated
    // outside-availability move (owner re-checked above AND re-authorized in the
    // command). It bypasses ONLY the working-hours window; the command still
    // enforces blockouts, collisions, buffers, breaks, pause and eligibility.
    // available_slot came from the hours-respecting slot list → validated (false).
    p_allow_outside_availability: mode === "custom_time",
  });

  if (error) {
    // §7.11: an exclusion violation (double-book / block / break / blockout) -> safe conflict copy.
    if (
      (error as { code?: string }).code === "23P01" ||
      (error as { code?: string }).code === "HB001"
    ) {
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
    case "outside_availability":
      return { ok: false, error: "That time is outside the practitioner's availability. Choose another time." };
    case "buffer_conflict":
      // Soft buffer/gap (migration 0152); only on the non-override move path.
      return { ok: false, code: "conflict", error: "That time is within the buffer around another appointment. Choose another time." };
    case "practitioner_closed":
      return { ok: false, error: "That practitioner isn't working at that time. Choose another time." };
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

  // Committed. The RPC's result tells us WHAT changed, so the client email + the
  // UI copy are truthful (a same-time reassignment is not a "time changed").
  const resultKind: MoveResultKind =
    row.result === "reassigned"
      ? "reassigned"
      : row.result === "moved_and_reassigned"
        ? "moved_and_reassigned"
        : "moved";

  // Notify the client AFTER commit (best-effort, fail-open). A notification
  // failure NEVER reports the move as failed. The helper reads the post-commit
  // row (new time + new practitioner) and builds truthful copy for resultKind.
  const notificationStatus = await notifyAppointmentMoved(admin, {
    appointmentId,
    studioId: studio.id,
    appOrigin,
    resultKind,
  });

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  revalidatePath(`/calendar/${appointmentId}`);
  if (appt.client_id) revalidatePath(`/clients/${appt.client_id}`);
  revalidatePath("/dashboard");

  const verb =
    resultKind === "reassigned"
      ? "reassigned"
      : resultKind === "moved_and_reassigned"
        ? "moved and reassigned"
        : "moved";
  return {
    ok: true,
    appointmentId,
    startsAt: row.new_starts_at,
    endsAt: row.new_ends_at,
    resultKind,
    notificationStatus,
    message:
      notificationStatus === "degraded"
        ? `Appointment ${verb}, but the client notification could not be delivered.`
        : `Appointment ${verb}.`,
  };
}

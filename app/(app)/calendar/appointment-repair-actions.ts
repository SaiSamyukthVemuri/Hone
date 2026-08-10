"use server";

// APPOINTMENT BOUNDARY B4 — governed repair server actions.
//
// 0172 revoked direct anon/authenticated INSERT/UPDATE/DELETE on
// `public.appointments`, which closed an operational hatch nobody was using but
// which had been the only conceivable way to fix a mis-marked outcome or a
// wrong note. Migration 0173 supplies the governed replacements; this file is
// their ONLY runtime caller.
//
// These live in their own file rather than in `app/(app)/calendar/actions.ts`,
// which is already large and owns the day-to-day lifecycle. Repair is a
// separate, rarer, owner-gated concern and keeping it separate keeps the
// service-role allowlist entry precise: its scopeGuard names the RPCs, not the
// generic resolver that appears in nearly every authenticated action.
//
// SHAPE OF THE TRUST BOUNDARY
//   * The browser supplies an appointment id, an expected status, and text.
//   * It NEVER supplies a studio id, a practitioner id, a user id, or a role.
//     All four are resolved server-side by getCurrentPractitionerWithStudio(),
//     which requires an ACTIVE practitioner membership.
//   * The SQL then re-derives membership and role AGAIN from (studio_id,
//     user_id) via public.appointment_actor_role and enforces owner-only itself.
//     JavaScript makes no lifecycle decision: it does not decide what is
//     terminal, what is inside the repair window, or what blocks a reversal.
//     It forwards a result code.
//   * Sentinels are propagated TRUTHFULLY. A refusal is never reported as a
//     success, and a code this file does not recognise maps to a generic
//     failure rather than being silently treated as ok.

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createAdminClient } from "@/lib/supabase/admin-server";
// Constants and types live in a plain module: a `"use server"` file may export
// ONLY async functions, so `export const` here is a build error.
import {
  REVERTIBLE_STATUSES,
  MIN_REPAIR_REASON_LENGTH,
  MAX_APPOINTMENT_NOTES_LENGTH,
  REPAIR_WINDOW_MS,
  BASELINE_ACTION,
  type RevertibleStatus,
  type RepairResult,
  type AppointmentRepairState,
} from "./appointment-repair-contract";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const GENERIC_FAILURE = "Something went wrong. Please refresh and try again.";

// Practitioner-facing copy for every sentinel 0173 can return. Deliberately
// explains the situation rather than naming a developer code.
const REVERT_MESSAGES: Record<string, string> = {
  not_a_member: "You do not have access to this appointment.",
  not_owner: "Only the studio owner can correct an appointment outcome.",
  appointment_not_found: "This appointment could not be found.",
  not_terminal: "This appointment does not have an outcome to correct.",
  status_mismatch:
    "This appointment changed while you were looking at it. Refresh and try again.",
  reason_too_short: `Please give a reason of at least ${MIN_REPAIR_REASON_LENGTH} characters.`,
  no_audit_baseline:
    "This appointment has no recorded outcome history, so it cannot be corrected here.",
  repair_window_expired:
    "Outcomes can only be corrected within 72 hours. Please contact support.",
  blocked_rescheduled:
    "This appointment was rescheduled to a later booking, so restoring it would create a duplicate.",
  blocked_linked_session:
    "A treatment record is linked to this appointment, so its outcome cannot be changed.",
  blocked_payment_state:
    "A payment has already been processed for this appointment.",
  blocked_manual_fee:
    "A fee has already been charged for this appointment.",
  blocked_postcare_sent:
    "Aftercare has already been emailed to this client for this appointment.",
  // B8 / 0177. A postcare send has been claimed and has not settled, so an
  // aftercare email may be with the provider right now. Correcting the outcome
  // underneath it would email aftercare for a visit that is no longer
  // completed. Describes the SITUATION and the next step; the claim token and
  // the five-minute window are internal and are never surfaced.
  blocked_postcare_in_flight:
    "Postcare is currently being sent or its send status is unresolved. Refresh before correcting this appointment outcome.",
  slot_conflict:
    "That time is now booked by another appointment, so this one cannot be restored.",
};

const NOTES_MESSAGES: Record<string, string> = {
  not_a_member: "You do not have access to this appointment.",
  appointment_not_found: "This appointment could not be found.",
  notes_too_long: `Notes must be ${MAX_APPOINTMENT_NOTES_LENGTH} characters or fewer.`,
};

function mapSentinel(
  code: unknown,
  table: Record<string, string>,
): RepairResult {
  if (code === "ok") return { ok: true };
  if (typeof code === "string" && code in table) {
    return { ok: false, error: table[code] };
  }
  // An unrecognised or non-string code is a FAILURE, never a pass-through
  // success. This is the branch that keeps a future sentinel added to the SQL
  // from silently reading as "it worked".
  return { ok: false, error: GENERIC_FAILURE };
}

/**
 * Read-only: can this terminal appointment's outcome be corrected right now?
 *
 * Used by the appointment detail page so a blocked appointment shows an
 * explanation rather than a control that would inevitably fail. It reuses the
 * SAME 0173 helper the command uses for blocking dependents, so the UI and the
 * command cannot disagree about what blocks a repair.
 *
 * This never mutates and never leaks another studio's data: the studio is
 * resolved server-side and every lookup is scoped to it.
 */
export async function loadAppointmentRepairStateAction(
  appointmentId: string,
): Promise<AppointmentRepairState> {
  let studioId: string;
  try {
    const { studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
  } catch {
    return { repairable: false, reason: REVERT_MESSAGES.not_a_member };
  }
  if (!UUID_RE.test(appointmentId ?? "")) {
    return { repairable: false, reason: GENERIC_FAILURE };
  }

  const admin = createAdminClient();

  // STUDIO SCOPING, AND WHY IT IS THE FIRST THING THIS FUNCTION DOES.
  //
  // Every export of a `"use server"` module is a callable server action, so
  // this loader is reachable from any authenticated browser session with an
  // arbitrary appointment id — it is NOT merely an internal page helper.
  //
  // `appointment_audit` carries no `studio_id` (that column is B5/0174-era
  // work, deliberately out of scope here), so the baseline lookup below CANNOT
  // scope itself. Without this read it would answer for an appointment in
  // ANOTHER studio, turning the loader into a cross-studio state oracle and
  // letting the surface claim `repairable: true` for a row the command would
  // refuse. The appointment is therefore resolved by BOTH id and studio_id
  // first, and everything downstream keys off THIS row.
  //
  // The status is read from the DATABASE rather than accepted as an argument
  // for the same reason: a caller could otherwise name a status the row does
  // not have and steer the baseline lookup at the wrong audit action.
  const { data: appt, error: apptErr } = await admin
    .from("appointments")
    .select("status")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (apptErr) return { repairable: false, reason: GENERIC_FAILURE };
  if (!appt) {
    return { repairable: false, reason: REVERT_MESSAGES.appointment_not_found };
  }

  const status = appt.status as RevertibleStatus;
  if (!REVERTIBLE_STATUSES.includes(status)) {
    return { repairable: false, reason: REVERT_MESSAGES.not_terminal };
  }

  const { data: blocking, error: blockingErr } = await admin.rpc(
    "appointment_has_blocking_dependents",
    { p_appointment_id: appointmentId, p_studio_id: studioId },
  );
  if (blockingErr) return { repairable: false, reason: GENERIC_FAILURE };
  if (typeof blocking === "string" && blocking.length > 0) {
    return {
      repairable: false,
      reason: REVERT_MESSAGES[`blocked_${blocking}`] ?? GENERIC_FAILURE,
    };
  }

  // The audit baseline that established the current outcome, and the window
  // measured from it — the same anchor the command uses.
  const { data: baseline, error: baselineErr } = await admin
    .from("appointment_audit")
    .select("created_at")
    .eq("appointment_id", appointmentId)
    .eq("action", BASELINE_ACTION[status])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (baselineErr) return { repairable: false, reason: GENERIC_FAILURE };
  if (!baseline) {
    return { repairable: false, reason: REVERT_MESSAGES.no_audit_baseline };
  }

  const elapsed = Date.now() - new Date(baseline.created_at as string).getTime();
  if (!Number.isFinite(elapsed) || elapsed > REPAIR_WINDOW_MS) {
    return { repairable: false, reason: REVERT_MESSAGES.repair_window_expired };
  }

  return { repairable: true };
}

export type RevertAppointmentOutcomeInput = {
  appointmentId: string;
  expectedStatus: RevertibleStatus;
  reason: string;
};

/**
 * Restore a terminal appointment (completed / no_show / cancelled) to
 * confirmed, through the governed 0173 command.
 *
 * Owner-only — enforced in SQL, not here. `expectedStatus` is the status the
 * practitioner was actually looking at; the command uses it for optimistic
 * concurrency and refuses if the row has moved.
 */
export async function revertAppointmentOutcomeAction(
  input: RevertAppointmentOutcomeInput,
): Promise<RepairResult> {
  let studioId: string;
  let actorUserId: string | null;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    actorUserId = practitioner.user_id;
  } catch {
    return { ok: false, error: GENERIC_FAILURE };
  }
  if (!actorUserId) return { ok: false, error: GENERIC_FAILURE };

  // Input SHAPE validation only. Nothing here decides whether the repair is
  // allowed; that is the command's job.
  if (!UUID_RE.test(input?.appointmentId ?? "")) {
    return { ok: false, error: GENERIC_FAILURE };
  }
  if (!REVERTIBLE_STATUSES.includes(input?.expectedStatus)) {
    return { ok: false, error: GENERIC_FAILURE };
  }
  const reason = typeof input?.reason === "string" ? input.reason : "";

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("revert_appointment_outcome", {
    p_appointment_id: input.appointmentId,
    p_studio_id: studioId,
    p_actor_user_id: actorUserId,
    p_expected_status: input.expectedStatus,
    // Sent raw: `btrim` and the minimum-length check belong to SQL so the
    // browser cannot satisfy them with whitespace.
    p_reason: reason,
  });
  if (error) return { ok: false, error: GENERIC_FAILURE };

  const result = mapSentinel(data, REVERT_MESSAGES);
  if (result.ok) {
    revalidatePath(`/calendar/${input.appointmentId}`);
    revalidatePath("/calendar");
  }
  return result;
}

export type SetAppointmentNotesInput = {
  appointmentId: string;
  notes: string;
};

/**
 * Correct an appointment's notes through the governed 0173 command.
 *
 * Any ACTIVE studio member may do this (unlike outcome reversal): notes are
 * operational text the practitioner who ran the visit needs to be able to fix.
 * The audit records lengths only — never the note text.
 */
export async function setAppointmentNotesAction(
  input: SetAppointmentNotesInput,
): Promise<RepairResult> {
  let studioId: string;
  let actorUserId: string | null;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    actorUserId = practitioner.user_id;
  } catch {
    return { ok: false, error: GENERIC_FAILURE };
  }
  if (!actorUserId) return { ok: false, error: GENERIC_FAILURE };

  if (!UUID_RE.test(input?.appointmentId ?? "")) {
    return { ok: false, error: GENERIC_FAILURE };
  }
  const notes = typeof input?.notes === "string" ? input.notes : "";

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("set_appointment_notes", {
    p_appointment_id: input.appointmentId,
    p_studio_id: studioId,
    p_actor_user_id: actorUserId,
    // Sent raw: SQL owns btrim, the blank -> NULL rule, and the ceiling.
    p_notes: notes,
  });
  if (error) return { ok: false, error: GENERIC_FAILURE };

  const result = mapSentinel(data, NOTES_MESSAGES);
  if (result.ok) {
    revalidatePath(`/calendar/${input.appointmentId}`);
  }
  return result;
}

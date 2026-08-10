"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAvailableSlots, INTERNAL_SLOT_PACKING } from "@/lib/booking/slots";
import { captureServerEvent } from "@/lib/analytics/server";
import { generateCancellationToken } from "@/lib/booking/tokens";
import {
  generateAppointmentToken,
  hashAppointmentToken,
} from "@/lib/booking/appointment-token";
import { ensureIntakeForClient } from "@/lib/intake/queries";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import {
  logEmailFailure,
  recordEmailAttempt,
  sendBookingConfirmationToClient,
  sendBookingNotificationToPractitioner,
  sendCancellationEmail,
  sendPostcareToClient,
} from "@/lib/email/send-appointment";
import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";
import { localDateString } from "@/lib/booking/tz";
import { getRequiredAppOrigin } from "@/lib/app-origin";

export type BookResult =
  | { ok: true; appointmentId: string }
  | { ok: false; error: string; code?: "slot_taken" };

// Part 4: the canonical booking command's result row + safe owner-facing copy.
type BookingRpcRow = {
  result: string;
  appointment_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
};

function bookingResultMessage(result: string | undefined): string {
  switch (result) {
    case "booking_paused":
      return "New bookings are paused for this studio right now.";
    case "not_authorized":
      return "You can only book appointments for yourself.";
    case "invalid_practitioner":
      return "That practitioner isn't available for new bookings.";
    case "not_eligible":
      return "That practitioner isn't set up to perform this service.";
    case "invalid_client":
      return "Client not found.";
    case "invalid_service":
      return "Service not found.";
    case "invalid_time":
      return "That time is in the past. Please choose a future time.";
    case "invalid_duration":
      return "That appointment length isn't valid.";
    case "practitioner_closed":
      return "That practitioner isn't working at that time.";
    case "outside_availability":
      return "That time is outside the practitioner's availability.";
    case "buffer_conflict":
      // Soft buffer/gap (migration 0152). Only reachable on the NON-override
      // path — the owner override bypasses the buffer server-side. Guide the
      // practitioner to the override rather than expose any DB detail.
      return "That time is within the buffer around another appointment. Turn on “Outside your regular availability” to book it anyway.";
    case "studio_not_found":
    case "invalid_studio":
      return "Could not create the appointment. Please try again.";
    default:
      return "Could not create the appointment. Please try again.";
  }
}

// Bounded operational marker: action + stage + SQLSTATE only. Never the raw
// DB/PostgREST message, row data, client, or clinical data.
function logBookingDbError(
  action: string,
  stage: string,
  code: string | undefined,
): void {
  console.error(`booking_action_db_error:${action}:${stage}:${code ?? "unknown"}`);
}

export async function bookAppointmentForClientAction(
  formData: FormData,
): Promise<BookResult> {
  const clientId = formDataStr(formData, "client_id");
  const serviceId = formDataStr(formData, "service_id");
  const startsAt = formDataStr(formData, "starts_at");
  const notes = formDataStrOrNull(formData, "notes");
  // Internal-only override. Public booking lives in a separate file
  // (app/book/[slug]/actions.ts) that does not read this flag, so a
  // public caller cannot use it to bypass published availability.
  // When true, this action SKIPS the JS-side getAvailableSlots
  // membership check below; every other safety primitive remains:
  //   * authenticated-practitioner gate
  //   * past-time guard
  //   * service / client / studio ownership checks
  //   * DB exclusion constraints from migrations 0029 + 0030, which
  //     unconditionally reject overlap, buffer violation, and any
  //     overlap with a blockout / recurring-break reservation row.
  const allowOutsideAvailability =
    formDataStr(formData, "allow_outside_availability") === "true";

  // Internal-only duration override. The drag-to-create flow on the
  // calendar passes the dragged range as duration_minutes_override so
  // a 45-minute drag books a 45-minute appointment even when the
  // service default is 30. Honoured ONLY when the override toggle is
  // on (allow_outside_availability=true) so the standard slot flow
  // keeps using service.default_duration_minutes and slot membership
  // checks remain valid. 15..360 minute window, multiples of 15
  // minutes to match the calendar grid snap (CLICK_SNAP_MINUTES in
  // DayColumn) and the public booking slot granularity
  // (SLOT_GRANULARITY_MINUTES in lib/booking/slots.ts).
  const DURATION_OVERRIDE_MIN = 15;
  const DURATION_OVERRIDE_MAX = 360;
  const DURATION_OVERRIDE_STEP = 15;
  function parseDurationOverride(raw: string | null): number | null {
    if (!raw) return null;
    const n = parseInt(raw.trim(), 10);
    if (!Number.isFinite(n)) return null;
    if (n < DURATION_OVERRIDE_MIN || n > DURATION_OVERRIDE_MAX) return null;
    if (n % DURATION_OVERRIDE_STEP !== 0) return null;
    return n;
  }
  const rawDurationOverride = formDataStrOrNull(
    formData,
    "duration_minutes_override",
  );
  const durationOverride = parseDurationOverride(rawDurationOverride);
  if (rawDurationOverride && durationOverride == null) {
    return {
      ok: false,
      error: `Duration must be a ${DURATION_OVERRIDE_STEP}-minute multiple between ${DURATION_OVERRIDE_MIN} and ${DURATION_OVERRIDE_MAX}.`,
    };
  }
  if (durationOverride != null && !allowOutsideAvailability) {
    // The drag-to-create path always pairs duration_minutes_override
    // with allow_outside_availability=true so this branch never fires
    // in practice; it's a defensive guard so a future caller cannot
    // silently change the booked length while still flowing through
    // the standard slot-membership check (which is built around the
    // service default).
    return {
      ok: false,
      error: "Custom duration requires the outside-availability override.",
    };
  }

  if (!clientId || !serviceId || !startsAt) {
    return { ok: false, error: "Missing fields." };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot book." };
  }
  // AUTHORIZATION: bypassing published availability is OWNER-ONLY on every
  // internal booking surface. This is the single server action that honours the
  // availability-bypass flag (the client-profile Book flow and the calendar
  // Quick Book both post to it; public booking lives in a separate file that
  // never reads the flag). The rule is a SIMPLE, unconditional binding policy:
  //
  //     allow_outside_availability = true  ⇒  practitioner.role must be "owner"
  //
  // It is enforced on the SERVER-RESOLVED role only. NO client-supplied signal —
  // duration, source, mode, form name, UI route, or drag-vs-click — is trusted as
  // authorization evidence, so a non-owner cannot bypass by attaching a custom
  // duration or forging a source label. (Because the drag-to-create path couples
  // a custom LENGTH to the availability bypass, non-owner custom-length booking
  // is owner-only too; see PRODUCT POLICY in docs/reviews/booking-availability-
  // authorization.md. The standard slot flow — no bypass — is unchanged for every
  // active practitioner.)
  if (allowOutsideAvailability && practitioner.role !== "owner") {
    return {
      ok: false,
      error: "Only the studio owner can book outside your normal availability.",
    };
  }

  // Part 4: a capacity-ON OWNER may book FOR another practitioner (submitted
  // practitioner_id); every other case (Legacy, member, owner-without-selection)
  // books for the acting practitioner. The canonical command re-validates the
  // target authoritatively (active, same-studio, service-eligible) — this is
  // only the default; nothing here is trusted as the final authority.
  const submittedPractitionerId = formDataStrOrNull(formData, "practitioner_id");
  const capacityOn = studio.practitioner_capacity_enabled === true;
  const targetPractitionerId =
    capacityOn && practitioner.role === "owner" && submittedPractitionerId
      ? submittedPractitionerId
      : practitioner.id;

  const supabase = await createClient();

  // Pull service for duration; also confirms it's in this studio.
  const { data: service, error: serviceErr } = await supabase
    .from("services")
    .select("*")
    .eq("id", serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (serviceErr) {
    logBookingDbError("book_appointment", "service_lookup", serviceErr.code);
    return { ok: false, error: "Could not load the service. Please try again." };
  }
  if (!service) return { ok: false, error: "Service not found." };

  // Confirm the client belongs to the studio. SMS consent + opt-out
  // selected so dispatchBookingEmails below can attempt SMS without a
  // second lookup. Internal booking does NOT modify either of those
  // fields; consent is established on the public booking surface or
  // by a practitioner action that is out of scope for this PR.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, name, email, phone, sms_consent_at, sms_opted_out_at")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) {
    logBookingDbError("book_appointment", "client_lookup", clientErr.code);
    return { ok: false, error: "Could not load the client. Please try again." };
  }
  if (!client) return { ok: false, error: "Client not found." };

  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: "Invalid start time." };
  }
  // Internal past-time guard: reject a start at or before now. Absolute UTC
  // comparison (start is an ISO instant), so a future slot later today still
  // books while an already-passed time is refused. Mirrors the public guard;
  // the shared slot engine / public booking are not touched.
  if (start.getTime() <= Date.now()) {
    return { ok: false, error: "That time is in the past. Please choose a future time." };
  }
  // Effective duration: drag-derived override when present (only
  // possible on the override path, gated above), otherwise the
  // service default. Conflict + buffer + blockout enforcement still
  // happens on the INSERT below via the DB exclusion constraints, so
  // a longer-than-default appointment can still collide and be
  // rejected by Postgres exactly the same way a default-length one
  // would.
  const effectiveDurationMinutes =
    durationOverride ?? service.default_duration_minutes;
  const end = new Date(start.getTime() + effectiveDurationMinutes * 60_000);

  // Re-verify the slot is still available (race-safe). Use the
  // studio's local date, not the UTC date, so a late-evening booking
  // does not look up the next day's slots.
  //
  // Override branch: when the practitioner explicitly ticked the
  // "Outside your regular availability" toggle on the drawer (and
  // the confirmation checkbox), this membership check is skipped.
  // The DB exclusion constraints from migrations 0029 + 0030 still
  // run on the INSERT below, so conflict / buffer / blockout / break
  // protection is preserved without any change to those rules.
  if (!allowOutsideAvailability) {
    const dateStr = localDateString(start, studio.timezone);
    // Part 4 Item 3: the precheck must run against the EXACT practitioner the DB
    // command will book (targetPractitionerId), not a studio-wide timeline. When
    // capacity is ON, getAvailableSlots reads that practitioner's own hours +
    // resource_key reservations, so A's calendar never advertises/consumes B's
    // slots. Legacy (flag off) ignores the practitioner id → studio-wide, as today.
    const slots = await getAvailableSlots(
      supabase,
      {
        id: studio.id,
        timezone: studio.timezone,
        default_appointment_duration_minutes:
          studio.default_appointment_duration_minutes,
        buffer_minutes: studio.buffer_minutes,
        practitioner_capacity_enabled: studio.practitioner_capacity_enabled,
      },
      dateStr,
      service.default_duration_minutes,
      undefined,
      targetPractitionerId,
      INTERNAL_SLOT_PACKING,
    );
    const isFree = slots.some(
      (s) => new Date(s.start).getTime() === start.getTime(),
    );
    if (!isFree) {
      return {
        ok: false,
        error:
          "That time is no longer available. Please choose another time.",
      };
    }
  }

  const appointmentToken = generateAppointmentToken();
  // Part 4: the canonical atomic command. One SECURITY DEFINER transaction takes
  // the studio-capacity advisory lock, re-validates the booking flag / actor
  // authority / target practitioner / service eligibility / client + service
  // tenancy, computes the interval server-side, and inserts the appointment +
  // audit atomically. The per-resource shadow GiST exclusion is the final race
  // authority (23P01 → rolled back → "slot taken"). Service-role only, so it
  // runs on the admin client.
  const admin = createAdminClient();
  // Part 4 Item 2/3: the v2 command derives the authoritative duration from the
  // LOCKED service row (never a caller-supplied length) and runs every booking
  // through the shared, target-aware availability validator. The custom length
  // (p_duration_override_minutes) and the availability bypass
  // (p_allow_outside_availability) are OWNER-ONLY and re-checked server-side
  // inside the command — the values below are only honoured for an owner actor.
  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "create_internal_appointment_v2",
    {
      p_studio_id: studio.id,
      p_actor_practitioner_id: practitioner.id,
      p_target_practitioner_id: targetPractitionerId,
      p_client_id: clientId,
      p_service_id: serviceId,
      p_starts_at: start.toISOString(),
      p_cancellation_token_hash: hashAppointmentToken(appointmentToken),
      p_notes: notes,
      p_duration_override_minutes: durationOverride,
      p_allow_outside_availability: allowOutsideAvailability,
    },
  );
  if (rpcErr) {
    // 23P01 = the per-resource exclusion — the slot was taken between the
    // advisory pre-check and the insert. Safe, structured; no raw DB text.
    if (rpcErr.code === "23P01") {
      console.error(
        JSON.stringify({
          event: "booking_slot_collision",
          studioId: studio.id,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          source: "in_app_calendar",
          timestamp: new Date().toISOString(),
        }),
      );
      return {
        ok: false,
        error: "That time is no longer available. Please choose another time.",
        code: "slot_taken",
      };
    }
    logBookingDbError("book_appointment", "rpc", rpcErr.code);
    return { ok: false, error: "Could not create the appointment. Please try again." };
  }
  const outcome = (rpcRows as BookingRpcRow[] | null)?.[0];
  if (!outcome || outcome.result !== "created" || !outcome.appointment_id) {
    return { ok: false, error: bookingResultMessage(outcome?.result) };
  }
  const createdId = outcome.appointment_id;
  // Fetch the created row for the (existing) email/SMS dispatch path.
  const { data: created } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", createdId)
    .maybeSingle();
  if (!created) {
    // Committed, but the follow-up read failed — the booking still succeeded.
    revalidatePath("/calendar");
    return { ok: true, appointmentId: createdId };
  }

  // The appointment is COMMITTED (create_internal_appointment_v2 returned). The
  // post-commit notification dispatch is best-effort/fail-open: a throwing helper
  // (e.g. a transient read inside the email context) must NEVER turn a committed
  // booking into a client-visible failure + a confusing re-submit. Mirrors the
  // follow-up-read handling above and the public booking flow. Bounded, PHI-free.
  try {
    await dispatchBookingEmails({
      appointment: created,
      service,
      studio,
      practitionerName: practitioner.display_name?.trim() || practitioner.email,
      practitionerEmail: practitioner.email,
      clientName: client.name,
      clientEmail: client.email,
      clientPhone: client.phone,
      clientSmsConsentAt: client.sms_consent_at,
      clientSmsOptedOutAt: client.sms_opted_out_at,
      notes,
    });
  } catch (e) {
    console.error(
      `booking_action_post_commit_error:dispatch:${e instanceof Error ? e.name : "unknown"}`,
    );
  }

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");

  // Post-response, bounded, never blocks or fails the committed booking.
  captureServerEvent({
    actor: { kind: "user", id: practitioner.id },
    event: "appointment_booked",
    properties: {
      studio_id: studio.id,
      source: "practitioner_ui",
    },
  });

  return { ok: true, appointmentId: created.id };
}

export async function cancelAppointmentAction(formData: FormData): Promise<{
  ok: true;
} | { ok: false; error: string }> {
  const appointmentId = formDataStr(formData, "appointment_id");
  const reason = formDataStrOrNull(formData, "reason");
  if (!appointmentId) return { ok: false, error: "Missing appointment id." };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  // P0-3: route the actual cancellation through the SECURITY DEFINER
  // RPC practitioner_cancel_appointment. The RPC validates the
  // (practitioner, studio) active-member predicate, locks the
  // appointment row FOR UPDATE, refuses any source state other than
  // 'confirmed' (terminal-safe), writes the audit row in the same
  // transaction, and reads cancelled_by from the live practitioner
  // role rather than trusting a browser-supplied value.
  //
  // We still need a couple of joined fields for the post-cancellation
  // client-notification email, so we look them up AFTER the RPC has
  // succeeded. We do NOT do any UPDATE on appointments here.
  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();
  const { data: rpcResult, error: rpcErr } = await admin.rpc(
    "practitioner_cancel_appointment",
    {
      p_appointment_id: appointmentId,
      p_studio_id: studio.id,
      p_practitioner_id: practitioner.id,
      p_reason: reason,
    },
  );
  if (rpcErr) {
    console.error(
      JSON.stringify({
        event: "practitioner_cancel_rpc_error",
        code: rpcErr.code,
        message: rpcErr.message,
        appointmentId,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not cancel this appointment." };
  }
  if (rpcResult === "already_cancelled") {
    // Idempotent: the practitioner clicked twice or two tabs raced. UI
    // refresh will show the cancelled state.
    return { ok: true };
  }
  if (rpcResult === "not_authorized") {
    return { ok: false, error: "You are not authorized to cancel this appointment." };
  }
  if (rpcResult !== "cancelled") {
    // 'not_cancelable' covers terminal source states (completed,
    // no_show) and missing rows. The UI must not present a Cancel
    // action for those states; this is the structural backstop.
    return {
      ok: false,
      error: "This appointment cannot be cancelled from its current state.",
    };
  }

  // Look up enough data to send the client-notification email.
  const supabase = await createClient();
  const { data: appt } = await supabase
    .from("appointments")
    .select("client_id, starts_at, duration_minutes, service_id")
    .eq("id", appointmentId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (appt) {
    const { data: client } = await supabase
      .from("clients")
      .select("name, email")
      .eq("id", appt.client_id)
      .maybeSingle();
    const { data: service } = appt.service_id
      ? await supabase
          .from("services")
          .select("name")
          .eq("id", appt.service_id)
          .maybeSingle()
      : { data: null };

    if (client?.email) {
      try {
        await sendCancellationEmail({
          to: client.email,
          recipientName: client.name,
          clientName: client.name,
          studio,
          serviceName: service?.name ?? "your appointment",
          durationMinutes: appt.duration_minutes,
          startsAt: new Date(appt.starts_at),
          // Server-derived actor: the AUTHENTICATED practitioner who ran
          // the cancel (getCurrentPractitionerWithStudio), with a safe
          // email fallback when the display name is blank. Role comes from
          // the live practitioner row, never a browser-supplied value.
          actorName: practitioner.display_name?.trim() || practitioner.email,
          actorRole: practitioner.role === "owner" ? "owner" : "practitioner",
          reason,
          isClient: true,
          rebookUrl: `${getRequiredAppOrigin()}/book/${studio.slug}`,
        });
      } catch (err) {
        console.error("client cancel notification email failed", err);
      }
    }

    revalidatePath(`/clients/${appt.client_id}`);
  }
  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  revalidatePath(`/calendar/${appointmentId}`);
  return { ok: true };
}

export type AppointmentStateActionResult =
  | { ok: true }
  // B8 / 0177. `code` distinguishes one outcome the UI must not render as an
  // ordinary failure: the provider ACCEPTED the email but Hone could not record
  // the send. Neither "sent" nor "failed" is true, and inviting an immediate
  // retry would risk a duplicate email.
  | { ok: false; code?: "provider_sent_status_unrecorded"; error: string };

// P0-1 + P0-3: practitioner-initiated mark complete. Calls the
// service-role-only RPC public.mark_appointment_complete (introduced by
// migration 0032, redefined by B6 / 0175) which:
//   * verifies the practitioner is active in the studio,
//   * locks the appointment FOR UPDATE,
//   * refuses any source state other than 'confirmed',
//   * refuses if starts_at is in the future — B6 moved the temporal gate from
//     ends_at to starts_at, so a visit that has BEGUN may be completed early,
//   * writes the appointment_audit row atomically.
// Completing early does not release capacity: the booked interval is untouched.
export async function markAppointmentCompleteAction(
  formData: FormData,
): Promise<AppointmentStateActionResult> {
  const appointmentId = formDataStr(formData, "appointment_id");
  if (!appointmentId) return { ok: false, error: "Missing appointment id." };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot mark appointments complete." };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();
  const { error: rpcErr } = await admin.rpc("mark_appointment_complete", {
    p_appointment_id: appointmentId,
    p_studio_id: studio.id,
    p_practitioner_id: practitioner.id,
  });
  if (rpcErr) {
    console.error(
      JSON.stringify({
        event: "mark_complete_rpc_error",
        code: rpcErr.code,
        message: rpcErr.message,
        appointmentId,
        timestamp: new Date().toISOString(),
      }),
    );
    // Map known structural failures to user-friendly messages.
    //
    // B6 / 0175's refusal. Checked FIRST so the current rule wins.
    if (rpcErr.message?.includes("has not started yet")) {
      return { ok: false, error: "This appointment hasn't started yet." };
    }
    // Pre-0175 refusal ('appointment has not yet ended', migration 0032).
    // Retained ONLY for deployment/rollback skew, where application code that
    // knows about B6 can briefly run against a database that does not. It
    // describes the rule that database is actually enforcing, so it stays
    // truthful there; it is never used to explain the 0175 refusal above.
    if (rpcErr.message?.includes("not yet ended")) {
      return { ok: false, error: "This appointment hasn't ended yet." };
    }
    if (rpcErr.message?.includes("not confirmed")) {
      return {
        ok: false,
        error: "Only confirmed appointments can be marked complete.",
      };
    }
    return { ok: false, error: "Could not mark this appointment complete." };
  }

  // Migration 0110: if the studio opted into auto_on_complete, send postcare
  // now. Fail-soft + idempotent (never throws; shares the manual sender's claim
  // columns) — a postcare failure must never fail the completion above.
  const { autoSendPostcareOnComplete } = await import("./postcare-auto-send");
  await autoSendPostcareOnComplete(appointmentId, studio.id, practitioner.id);

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  revalidatePath(`/calendar/${appointmentId}`);
  return { ok: true };
}

// P0-1 + P0-3: practitioner-initiated manual mark no-show.
// Replaces the previously-automatic cron flow. Calls the new
// SECURITY DEFINER RPC public.mark_appointment_no_show (migration 0033)
// which refuses any transition before ends_at has passed.
export async function markAppointmentNoShowAction(
  formData: FormData,
): Promise<AppointmentStateActionResult> {
  const appointmentId = formDataStr(formData, "appointment_id");
  if (!appointmentId) return { ok: false, error: "Missing appointment id." };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot mark no-shows." };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();
  const { data: rpcResult, error: rpcErr } = await admin.rpc(
    "mark_appointment_no_show",
    {
      p_appointment_id: appointmentId,
      p_studio_id: studio.id,
      p_practitioner_id: practitioner.id,
    },
  );
  if (rpcErr) {
    console.error(
      JSON.stringify({
        event: "mark_no_show_rpc_error",
        code: rpcErr.code,
        message: rpcErr.message,
        appointmentId,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not mark this appointment as no-show." };
  }
  if (rpcResult === "too_early") {
    return {
      ok: false,
      error: "You can only mark a no-show after the appointment end time.",
    };
  }
  if (rpcResult === "not_authorized") {
    return { ok: false, error: "You are not authorized to mark this appointment." };
  }
  if (rpcResult !== "marked") {
    return {
      ok: false,
      error: "Only confirmed appointments can be marked as no-show.",
    };
  }

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  revalidatePath(`/calendar/${appointmentId}`);
  return { ok: true };
}

function formDataStr(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function formDataStrOrNull(fd: FormData, key: string): string | null {
  const v = formDataStr(fd, key);
  return v.length === 0 ? null : v;
}

// Phase C calendar-first booking: narrow authenticated action that
// creates a client from inside the calendar quick-book drawer and
// returns the new client's id + display fields. The existing
// createClientAction (app/(app)/clients/new/actions.ts) redirects on
// success and therefore cannot be reused from a drawer that needs
// to stay open and auto-select the new client.
//
// Boundaries observed (mirroring bookAppointmentForClientAction):
//   * resolves practitioner + studio server-side via
//     getCurrentPractitionerWithStudio — studio_id is NEVER trusted
//     from the browser
//   * uses the user-scoped Supabase client (createClient), not
//     createAdminClient — RLS still applies
//   * inactive practitioners are refused, same gate as booking
//   * only the minimal name / email / phone / pronouns fields are
//     accepted; the full client profile (DOB, fitzpatrick, allergies,
//     emergency contact, intake) is filled in later from /clients/[id]
//   * does NOT send emails, does NOT create appointments, does NOT
//     touch intake, does NOT touch Stripe or payments
export type CreateClientFromCalendarResult =
  | {
      ok: true;
      client: {
        id: string;
        name: string;
        email: string | null;
        phone: string | null;
        pronouns: string | null;
      };
    }
  | { ok: false; error: string };

export async function createClientForCalendarBookingAction(
  formData: FormData,
): Promise<CreateClientFromCalendarResult> {
  const name = formDataStr(formData, "name");
  if (!name) return { ok: false, error: "Name is required." };
  const email = formDataStrOrNull(formData, "email");
  const phone = formDataStrOrNull(formData, "phone");
  const pronouns = formDataStrOrNull(formData, "pronouns");

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot add clients." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .insert({
      studio_id: studio.id,
      name,
      email,
      phone,
      pronouns,
      created_by: practitioner.id,
    })
    .select("id, name, email, phone, pronouns")
    .single();

  if (error || !data) {
    // Never surface a raw Postgres/PostgREST message (constraint names, schema
    // hints, or submitted values) to the browser — the quick-book drawer renders
    // this string verbatim. Log a bounded SQLSTATE marker instead.
    logBookingDbError("create_client", "insert", error?.code);
    return { ok: false, error: "Could not create the client. Please try again." };
  }

  // Same pages that the existing createClientAction revalidates —
  // keeps Clients list + Dashboard recent-clients in sync. We also
  // revalidate /calendar so a follow-up booking sees the new client
  // in the server-passed clients prop after router.refresh().
  revalidatePath("/clients");
  revalidatePath("/dashboard");
  revalidatePath("/calendar");

  return {
    ok: true,
    client: {
      id: data.id,
      name: data.name,
      email: data.email,
      phone: data.phone,
      pronouns: data.pronouns,
    },
  };
}

// Calendar rebook shortcut: read-only lookup of a client's "last
// service" so the quick-book drawer can offer a one-tap rebook. Lazy —
// called only when an existing client is selected in the drawer, never
// prefetched for the whole client list.
//
// "Last service" priority (cancelled and no-show are ALWAYS excluded):
//   1. Most recent `completed` appointment with a service_id.
//   2. Else the most recent `confirmed` (booked, not cancelled/no-show)
//      appointment with a service_id.
// Completed is the strongest signal and wins even if an upcoming
// confirmed booking is more recent.
//
// Boundaries: user-scoped createClient() (RLS applies) — no
// createAdminClient; studio resolved server-side (studio_id never
// trusted from the browser); read-only SELECTs, no writes, no emails,
// no booking creation, no slot/availability computation.
export type LastServiceResult =
  | {
      ok: true;
      lastService: {
        serviceId: string;
        serviceName: string;
        durationMinutes: number;
        // Studio-local YYYY-MM-DD of the last appointment.
        lastLocalDate: string;
      } | null;
    }
  | { ok: false; error: string };

export async function fetchLastServiceForClientAction(
  clientId: string,
): Promise<LastServiceResult> {
  const id = (clientId ?? "").trim();
  if (!id) return { ok: false, error: "Missing client id." };

  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  type Row = {
    service_id: string | null;
    starts_at: string;
    duration_minutes: number;
    service:
      | { name: string | null }
      | { name: string | null }[]
      | null;
  };

  async function mostRecentWithStatus(status: string): Promise<Row | null> {
    const { data, error } = await supabase
      .from("appointments")
      .select("service_id, starts_at, duration_minutes, service:services(name)")
      .eq("studio_id", studio.id)
      .eq("client_id", id)
      .eq("status", status)
      .not("service_id", "is", null)
      .order("starts_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      // Log the SQLSTATE only; never propagate the raw DB text to the browser.
      logBookingDbError("last_service", "query", error.code);
      throw new Error("last_service_query_failed");
    }
    return (data as Row | null) ?? null;
  }

  try {
    // Priority 1: most recent completed. Priority 2: most recent confirmed.
    const row =
      (await mostRecentWithStatus("completed")) ??
      (await mostRecentWithStatus("confirmed"));
    if (!row || !row.service_id) return { ok: true, lastService: null };

    const svc = Array.isArray(row.service) ? row.service[0] : row.service;
    const serviceName = svc?.name?.trim() || "Service";
    return {
      ok: true,
      lastService: {
        serviceId: row.service_id,
        serviceName,
        durationMinutes: row.duration_minutes,
        lastLocalDate: localDateString(new Date(row.starts_at), studio.timezone),
      },
    };
  } catch {
    // Fixed, safe copy — the inner query already logged a bounded SQLSTATE marker.
    return { ok: false, error: "Could not load the last service. Please try again." };
  }
}

type DispatchParams = {
  appointment: import("@/lib/types/database").Appointment;
  service: import("@/lib/types/database").Service;
  studio: import("@/lib/types/database").Studio;
  practitionerName: string;
  practitionerEmail: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  // PR Twilio v1: optional SMS consent fields. Defaulted to null in
  // older callers; the SMS attempt fails the consent gate cleanly
  // when missing or null.
  clientSmsConsentAt?: string | null;
  clientSmsOptedOutAt?: string | null;
  notes: string | null;
};

async function dispatchBookingEmails(p: DispatchParams) {
  // Single helper call up front; downstream lines share the same origin.
  const appOrigin = getRequiredAppOrigin();
  // PR #260/#264: appointment tokens are hash-only at rest (the raw
  // cancellation_token column was dropped in PR #264, migration 0091).
  // Surfaces that rebuild a link after creation cannot read a raw token,
  // so we mint the stateless HMAC token (expires at the appointment start)
  // for every link. /cancel, /manage, and /reschedule all accept the HMAC
  // token (they hash the URL token against cancellation_token_hash and
  // fall back to verifyCancellationToken), so all three links resolve.
  const token = generateCancellationToken(
    p.appointment.id,
    new Date(p.appointment.starts_at),
  );
  const cancellationUrl = `${appOrigin}/cancel/${token}`;
  const rescheduleUrl = `${appOrigin}/reschedule/${token}`;
  // SMS uses the single neutral /manage/<token> entry point, built from the
  // same HMAC token so a client sees one policy-aware landing page before
  // choosing cancel or reschedule.
  const manageUrl = `${appOrigin}/manage/${token}`;
  const appointmentUrl = `${appOrigin}/calendar`;

  if (p.clientEmail && p.studio.send_confirmation_emails) {
    const intake = await ensureIntakeForClient({
      studioId: p.studio.id,
      clientId: p.appointment.client_id,
      appOrigin,
    });
    const treatmentTimeLine = p.studio.show_treatment_time_to_clients
      ? buildTreatmentTimeLine({
          enabled: true,
          clientFirstName: p.clientName.split(/\s+/)[0] || p.clientName,
          context: await getTreatmentTimeContextForEmail(
            p.studio.id,
            p.appointment.client_id,
          ),
        })
      : null;
    // Email reporting is truthful: recordEmailAttempt stamps
    // confirmation_sent_at only when Resend actually delivered. The old
    // code path stamped on every booking, falsely advertising delivery.
    const result = await sendBookingConfirmationToClient({
      appointment: p.appointment,
      service: p.service,
      studio: p.studio,
      practitionerDisplayName: p.practitionerName,
      clientName: p.clientName,
      clientEmail: p.clientEmail,
      cancellationUrl,
      rescheduleUrl,
      intakeUrl: intake?.url ?? null,
      treatmentTimeLine,
      appBaseUrl: appOrigin,
    });
    const { createAdminClient } = await import("@/lib/supabase/admin-server");
    const admin = createAdminClient();
    await recordEmailAttempt(admin, p.appointment.id, "confirmation", result.ok);
    if (!result.ok) {
      logEmailFailure({
        appointmentId: p.appointment.id,
        emailType: "confirmation",
        error: result.error,
        retryable: result.retryable,
        attemptNumber: 1,
      });
    }

    // SMS confirmation for the internal booking surface. We deliberately
    // do NOT modify SMS consent here (consent is collected on the
    // public booking surface or by a practitioner action that this PR
    // does not ship); we only attempt to send if the consent gate
    // inside the helper passes. The helper handles toggle, opt-out,
    // phone normalization, claim race, and timeouts; it never throws.
    await sendBookingConfirmationSmsToClient({
      admin,
      appointmentId: p.appointment.id,
      startsAt: new Date(p.appointment.starts_at),
      timezone: p.studio.timezone,
      studio: p.studio,
      client: {
        phone: p.clientPhone,
        sms_consent_at: p.clientSmsConsentAt ?? null,
        sms_opted_out_at: p.clientSmsOptedOutAt ?? null,
      },
      intakeUrl: intake?.url ?? null,
      manageUrl,
    });
  }
  // Migration 0047: studio owners can opt out of the practitioner
  // new-booking notification. Default true preserves the previous
  // unconditional behavior. Client confirmation above already gates
  // separately on send_confirmation_emails and is unaffected here.
  if (p.studio.notify_practitioner_on_new_booking === false) {
    return;
  }
  await sendBookingNotificationToPractitioner({
    appointment: p.appointment,
    service: p.service,
    studio: p.studio,
    practitionerName: p.practitionerName,
    practitionerEmail: p.practitionerEmail,
    clientName: p.clientName,
    clientEmail: p.clientEmail ?? "",
    clientPhone: p.clientPhone,
    notes: p.notes,
    appointmentUrl,
    // PR #163. Practitioner-side bookings (created from the
    // calendar) never ask the "How did you hear about us?"
    // question; the practitioner knows the source already. Always
    // null here.
    referralSourceLabel: null,
  });
}

// ---------------------------------------------------------------------------
// sendPostcareEmailAction (manual practitioner-triggered postcare v1)
// ---------------------------------------------------------------------------
//
// Manual ONLY. No auto-send, no cron, no completion-event coupling.
// Decoupled from appointment lifecycle: does NOT change appointment
// status, does NOT call public.mark_appointment_complete (whose UI was
// removed in PR #72), does NOT depend on display-derived "done", and
// does NOT rely on payment.
//
// B8 / 0177 — THIS ACTION WRITES NO APPOINTMENT COLUMN.
//
// It used to own four direct UPDATEs on the six postcare columns: a
// conditional first-send claim, an unconditional resend claim, and the two
// settlement writes. All four are gone, and service_role no longer holds even
// column-level UPDATE on `public.appointments` to reissue them. The shape is
// now a two-command state machine:
//
//     claim_postcare_send  ->  provider call  ->  settle_postcare_send
//
// SQL owns every rule that used to live in a WHERE clause here: the
// completed-only gate, first-send vs resend, the five-minute stale window, the
// attempt counter, the actor's active same-studio membership, and the claim
// timestamp itself. Race-safety is no longer "Postgres serialises per-row
// UPDATEs and one click wins" — the claim command hands exactly one caller a
// token, and settlement only writes while that token still matches. That closed
// a real gap: the old resend path bumped the claim unconditionally, so two
// concurrent resends could BOTH reach the provider, mitigated only by a
// disabled button.
//
// The old documented trade-off is retired with the code that needed it: sent_at
// is no longer stamped at claim time, so a provider failure can no longer leave
// a false "sent" behind.
//
// Provider truth and persisted truth stay distinct. A provider success whose
// settlement does not commit is neither a success nor a failure, and is
// reported as `provider_sent_status_unrecorded` rather than being flattened
// into either.

// SAFE/GENERIC practitioner copy. The provider payload never reaches it: for a
// settlement the safe text is derived in SQL from the retryable boolean alone,
// and the map below covers only the command's REFUSAL vocabulary. Never the raw
// Resend payload, client email/name, health/treatment data, or exception detail.
// B8 / 0177. Maps the command's result vocabulary to safe practitioner copy.
// Every value here is a REFUSAL: the provider has not been called and nothing
// has been written.
function postcareClaimRefusalCopy(result: string): string {
  switch (result) {
    case "not_completed":
      return "Postcare can be sent once the appointment is completed.";
    case "already_sent":
      return "Postcare has already been sent. Open the page again to use Resend.";
    case "never_sent":
      return "Postcare has not been sent yet, so there is nothing to resend.";
    case "already_claimed":
      return "Postcare is being sent in another window. Refresh in a moment.";
    case "not_authorized":
      return "You do not have access to send postcare for this appointment.";
    default:
      return "Could not send postcare. Please try again.";
  }
}

// Bounded structured logging: codes and ids only, never provider payloads.
function logPostcare(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

export async function sendPostcareEmailAction(
  formData: FormData,
): Promise<AppointmentStateActionResult> {
  const appointmentId = formDataStr(formData, "appointment_id");
  const isResend = formDataStr(formData, "is_resend") === "true";
  // Consultation appointments may include a short electrolysis test
  // treatment (per Chloe's clarification). When that happens, postcare
  // is appropriate. To keep the action explicit, the caller MUST send
  // treatment_performed_during_consultation=true for consultation
  // services; a client-side checkbox alone is not the gate, the
  // server checks this flag below.
  const treatmentPerformedDuringConsultation =
    formDataStr(formData, "treatment_performed_during_consultation") === "true";
  if (!appointmentId) return { ok: false, error: "Missing appointment id." };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot send postcare." };
  }

  // The admin client is used for the join so the full studio postcare text,
  // the service modality and the client email arrive in one round-trip, and
  // because the two 0177 commands are service_role-only. It is NOT needed to
  // "write through" any longer — this action issues no appointment UPDATE at
  // all, and service_role holds no UPDATE grant to issue one with. RLS would
  // also permit a member-scoped read here; the existing email-sending actions
  // in this file all use the admin client and we keep the pattern.
  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const admin = createAdminClient();
  const { data: appt, error: lookupErr } = await admin
    .from("appointments")
    .select(
      "id, studio_id, status, starts_at, postcare_email_sent_at, postcare_email_send_attempts, postcare_email_claimed_at, postcare_email_failed_at, client:clients(id, name, email), service:services(id, name, modality), studio:studios(id, name, owner_email, timezone, postcare_aftercare_text, postcare_warning_signs_text, postcare_product_recommendations_text, postcare_review_url, postcare_review_prompt_text, postcare_contact_email), practitioner:practitioners!appointments_practitioner_same_studio_fk(id, display_name)",
    )
    .eq("id", appointmentId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (lookupErr) {
    console.error(
      JSON.stringify({
        event: "send_postcare_lookup_failed",
        code: lookupErr.code,
        message: lookupErr.message,
        appointmentId,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not send postcare. Please try again." };
  }
  if (!appt) return { ok: false, error: "Appointment not found." };

  const client = pickPostcareRel(appt.client);
  const service = pickPostcareRel(appt.service);
  const studioRow = pickPostcareRel(appt.studio);
  const performer = pickPostcareRel(appt.practitioner);

  if (!client?.email) {
    return {
      ok: false,
      error: "This client has no email on file. Add one to send postcare.",
    };
  }
  if (
    service?.modality === "consultation" &&
    !treatmentPerformedDuringConsultation
  ) {
    // Consultations are gated behind an explicit practitioner-attested
    // boolean. Missing or false means the appointment was consultation
    // only (no electrolysis); postcare would not be appropriate.
    return {
      ok: false,
      error:
        "Postcare for consultations can only be sent when treatment was performed.",
    };
  }
  if (!studioRow) {
    return { ok: false, error: "Could not send postcare. Please try again." };
  }
  if (
    !studioRow.postcare_aftercare_text ||
    studioRow.postcare_aftercare_text.trim().length === 0
  ) {
    return {
      ok: false,
      error:
        "Add postcare aftercare text in Studio settings before sending postcare.",
    };
  }


  // B8 / 0177 — CLAIM THE SEND IN THE DATABASE.
  //
  // This replaces two direct UPDATEs (first-send claim and resend claim). The
  // database now owns the claim timestamp, the attempt counter and the stale
  // window. Nothing below generates a timestamp for a postcare column, and no
  // branch here may write one.
  //
  // WHO THE ACTOR IS, stated exactly. THIS CALL SITE authenticates the human —
  // getCurrentPractitionerWithStudio() above requires an active practitioner
  // membership — and resolves `practitioner.id` server-side; the browser never
  // supplies it. service_role is transport, so the database cannot verify who
  // is behind the connection: what `claim_postcare_send` does is VALIDATE the
  // supplied identity, rejecting an inactive or cross-studio practitioner. It
  // does not bind that id to the authenticated session, and a service_role
  // caller could name a different active same-studio practitioner. The residual
  // trust therefore lives here, in the call site, which is why the actor is
  // resolved from the session and never accepted from the request.
  //
  // The resend path is materially safer than what it replaces: it used to bump
  // the claim unconditionally, so two concurrent resends could BOTH reach the
  // provider and the client could receive two emails. The mitigation was the
  // button's disabled state. Now exactly one caller wins the claim.
  const { data: claimRows, error: claimRpcErr } = await admin.rpc(
    "claim_postcare_send",
    {
      p_appointment_id: appointmentId,
      p_studio_id: studio.id,
      p_actor_practitioner_id: practitioner.id,
      p_is_resend: isResend,
    },
  );
  if (claimRpcErr) {
    // Includes the app-first deployment window, where 0177 is not yet applied
    // and PostgREST cannot find the function. FAIL CLOSED: there is deliberately
    // no direct-UPDATE fallback, because this route no longer settles either —
    // a fallback claim would send an email the database could never record.
    logPostcare("send_postcare_claim_command_failed", {
      code: claimRpcErr.code,
      appointmentId,
    });
    return { ok: false, error: "Could not send postcare. Please try again." };
  }
  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | { result: string; claimed_at: string | null }
    | null
    | undefined;
  if (!claim) {
    logPostcare("send_postcare_claim_empty", { appointmentId });
    return { ok: false, error: "Could not send postcare. Please try again." };
  }
  if (claim.result !== "claimed" || !claim.claimed_at) {
    // Every non-winning outcome ends here, BEFORE the provider is called.
    return { ok: false, error: postcareClaimRefusalCopy(claim.result) };
  }
  // THE TOKEN. Forwarded to settlement byte-for-byte exactly as the database
  // returned it. Re-deriving it — `new Date(...).toISOString()` — would round a
  // microsecond value to milliseconds and every settlement would miss its own
  // claim, so the send would never be recorded.
  const claimToken = claim.claimed_at;

  const startsAt = appt.starts_at ? new Date(appt.starts_at) : null;
  const result = await sendPostcareToClient({
    clientName: client.name ?? "",
    clientEmail: client.email,
    studio: studioRow as unknown as import("@/lib/types/database").Studio,
    practitionerName: performer?.display_name ?? null,
    serviceName: service?.name ?? null,
    startsAt,
    aftercareText: studioRow.postcare_aftercare_text ?? null,
    warningSignsText: studioRow.postcare_warning_signs_text ?? null,
    productRecommendationsText:
      studioRow.postcare_product_recommendations_text ?? null,
    reviewUrl: studioRow.postcare_review_url ?? null,
    reviewPromptText: studioRow.postcare_review_prompt_text ?? null,
  });
  if (!result.ok) {
    // PR #311: the provider send FAILED. Record the failure honestly — set
    // failed_at + a SAFE/GENERIC last_error (never the raw provider payload,
    // client PII, or exception details) and clear the claim. Do NOT set
    // sent_at: a first send stays "not sent"; a resend keeps any prior real
    // sent_at intact (a failed resend never erases a real historical send).
    // logEmailFailure's emailType union doesn't include "postcare" and we
    // intentionally don't extend it (postcare bypasses record_email_attempt);
    // log inline with the postcare event tag.
    console.error(
      JSON.stringify({
        event: "send_postcare_email_failed",
        appointmentId,
        retryable: result.retryable,
        // Bounded: retryable category only. A raw provider error can carry the
        // recipient address and vendor internals, and the DB stores only the
        // safe derived copy — operational logging matches that posture.
        timestamp: new Date().toISOString(),
      }),
    );
    // B8: settle the FAILURE through the command, under the exact claim token.
    // The safe operator-facing copy is derived in SQL from `retryable` alone —
    // a raw provider error can carry recipient addresses and vendor internals
    // into a field practitioners read.
    const { data: settleRows, error: settleErr } = await admin.rpc(
      "settle_postcare_send",
      {
        p_appointment_id: appointmentId,
        p_studio_id: studio.id,
        p_claimed_at: claimToken,
        p_success: false,
        p_retryable: result.retryable,
      },
    );
    const settled = (Array.isArray(settleRows) ? settleRows[0] : settleRows) as
      | { result: string }
      | null
      | undefined;
    if (settleErr || settled?.result !== "settled") {
      // The send genuinely failed AND the settlement did not persist. Do not
      // fabricate a failure state here; the claim simply goes stale and becomes
      // reclaimable, which is the conservative outcome.
      logPostcare("send_postcare_settle_failure_unpersisted", {
        code: settleErr?.code ?? settled?.result ?? "unknown",
        appointmentId,
      });
    }
    revalidatePath(`/calendar/${appointmentId}`);
    return {
      ok: false,
      error:
        "Postcare email could not be sent. You can try resending it from the appointment page.",
    };
  }

  // PR #311: provider SUCCESS — now (and only now) stamp sent_at, and clear the
  // failure state + claim. "Sent" means Hone handed the email to the provider,
  // never delivered/received/opened.
  // B8: settle the SUCCESS through the command, under the exact claim token.
  // "Sent" means Hone handed the message to the provider; the DB clock stamps
  // when, so TypeScript never decides that a send happened or when.
  const { data: okRows, error: successSettleErr } = await admin.rpc(
    "settle_postcare_send",
    {
      p_appointment_id: appointmentId,
      p_studio_id: studio.id,
      p_claimed_at: claimToken,
      p_success: true,
      p_retryable: false,
    },
  );
  const okSettled = (Array.isArray(okRows) ? okRows[0] : okRows) as
    | { result: string }
    | null
    | undefined;
  const successWriteErr =
    successSettleErr ?? (okSettled?.result === "settled" ? null : { code: okSettled?.result });
  if (successWriteErr) {
    // The email DID hand off to the provider, but the success stamp failed.
    // Log it; the claim stays and is stale-reclaimable — we under-claim
    // ("still sending" → "not sent yet") rather than overclaim "sent".
    console.error(
      JSON.stringify({
        event: "send_postcare_success_write_failed",
        // The email DID reach the provider but the settlement did not persist.
        // Bounded metadata only, and deliberately NO repair: we under-claim
        // ("still sending" -> reclaimable) rather than fabricate a sent state.
        code: successWriteErr.code,
        appointmentId,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  revalidatePath(`/calendar/${appointmentId}`);
  if (successWriteErr) {
    // PROVIDER TRUTH != PERSISTED TRUTH. The provider accepted the message, so
    // this is not a failed send and the practitioner must not be nudged into
    // sending again — that would duplicate a real email. But settlement did not
    // commit, so there is no durable sent_at and the ordinary green "Postcare
    // sent" confirmation would be false.
    return {
      ok: false,
      code: "provider_sent_status_unrecorded",
      error:
        "The email provider accepted the message, but Hone could not record the send status. Refresh before trying again.",
    };
  }
  return { ok: true };
}

function pickPostcareRel<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { requireReceptionistWithStudio } from "@/lib/receptionist/identity";
import { utcInstantFromLocal } from "@/lib/booking/tz";
import { generateAppointmentToken, hashAppointmentToken } from "@/lib/booking/appointment-token";
import { dispatchBookingNotifications } from "@/lib/booking/booking-notifications";
import { notifyAppointmentMoved, type MoveNotificationKind } from "@/lib/email/notify-appointment-moved";
import { sendCancellationEmail } from "@/lib/email/send-appointment";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import type { Appointment, Service, Studio } from "@/lib/types/database";

// STUDIO-READY-02c (#824): the front desk books, moves and cancels.
//
// AUTHORITY IS THE DATABASE'S. Each action calls a 0220 receptionist command
// with the receptionist's OWN session. The command derives the actor from
// auth.uid() (receptionist_actor_id) and runs the SAME core as the
// practitioner commands: validator, exclusion, buffers, lock order. No actor
// id, override or note is ever sent, and the browser supplies only the
// appointment, client, service, practitioner and time.
//
// requireReceptionistWithStudio() resolves the studio server-side. It is the
// form's studio, not authority: a forged studio id is refused by the command.
//
// AFTER a command has committed, a service-role read loads exactly that
// appointment (by id AND studio) to send the same notifications the
// practitioner calendar sends. That read returns nothing to the browser, and it
// is best-effort: a notification failure never turns a committed booking into a
// failure.

export type FrontDeskActionState = { ok: boolean; message: string } | null;

const field = (fd: FormData, k: string): string => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bounded marker: action, stage and SQLSTATE only.
function logDeskError(action: string, stage: string, code: string | undefined): void {
  console.error(`front_desk_action_error:${action}:${stage}:${code ?? "unknown"}`);
}

/** Safe, receptionist-facing copy for the shared core's sentinels. Not exported:
 *  in a "use server" module every export is a client-callable endpoint. */
function frontDeskResultMessage(result: string | undefined): string {
  return RESULT_COPY[result ?? ""] ?? "Something went wrong. Please try again.";
}
const RESULT_COPY: Record<string, string> = {
  not_authorized: "You no longer have front-desk access to this studio.",
  booking_paused: "New bookings are paused for this studio right now.",
  invalid_practitioner: "That practitioner isn't available for bookings.",
  practitioner_reassignment_required:
    "This appointment's practitioner is no longer active. Choose another practitioner to move it.",
  not_eligible: "That practitioner isn't set up for this service.",
  invalid_client: "Client not found.",
  invalid_service: "Service not found.",
  invalid_time: "Choose a time in the future.",
  invalid_duration: "That appointment length isn't valid.",
  practitioner_closed: "That practitioner isn't working at that time.",
  outside_availability: "That time is outside the practitioner's availability.",
  buffer_conflict: "That time is too close to another appointment.",
  stale_appointment: "This appointment changed in another window. Refresh and try again.",
  appointment_not_found: "Appointment not found.",
  appointment_not_movable: "This appointment can no longer be moved.",
  not_cancelable: "This appointment can't be cancelled from its current state.",
  no_change: "Choose a different time or practitioner.",
};
const SLOT_TAKEN = "That time is no longer available. Choose another time.";

function instant(date: string, time: string, timezone: string): Date | null {
  if (!DATE.test(date) || !TIME.test(time)) return null;
  const d = utcInstantFromLocal(date, time, timezone);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function bookFrontDeskAppointmentAction(
  _prev: FrontDeskActionState,
  formData: FormData,
): Promise<FrontDeskActionState> {
  const clientId = field(formData, "client_id");
  const serviceId = field(formData, "service_id");
  const practitionerId = field(formData, "practitioner_id");
  if (![clientId, serviceId, practitionerId].every((v) => UUID.test(v))) {
    return { ok: false, message: "Choose a client, a service and a practitioner." };
  }
  const { studio } = await requireReceptionistWithStudio();
  const start = instant(field(formData, "date"), field(formData, "time"), studio.timezone);
  if (!start) return { ok: false, message: "Choose a date and time." };
  if (start.getTime() <= Date.now()) return { ok: false, message: RESULT_COPY.invalid_time };

  const supabase = await createClient();
  const token = generateAppointmentToken();
  const { data, error } = await supabase.rpc("receptionist_create_appointment", {
    p_studio_id: studio.id,
    p_target_practitioner_id: practitionerId,
    p_client_id: clientId,
    p_service_id: serviceId,
    p_starts_at: start.toISOString(),
    p_cancellation_token_hash: hashAppointmentToken(token),
  });
  if (error) {
    if (error.code === "23P01") return { ok: false, message: SLOT_TAKEN };
    logDeskError("book", "rpc", error.code);
    return { ok: false, message: "Could not create the appointment. Please try again." };
  }
  const row = (data as Array<{ result: string; appointment_id: string | null }> | null)?.[0];
  if (row?.result !== "created" || !row.appointment_id) {
    return { ok: false, message: frontDeskResultMessage(row?.result) };
  }

  // COMMITTED. Same notifications as a practitioner booking, best-effort.
  try {
    await notifyCreated(row.appointment_id, studio.id);
  } catch (e) {
    logDeskError("book", `post_commit_${e instanceof Error ? e.name : "unknown"}`, undefined);
  }
  revalidatePath("/front-desk");
  return { ok: true, message: "Appointment booked." };
}

async function notifyCreated(appointmentId: string, studioId: string): Promise<void> {
  const admin = createAdminClient();
  const { data: appointment } = await admin
    .from("appointments")
    .select("*")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (!appointment) return;
  const a = appointment as Appointment;
  const [studioRow, serviceRow, clientRow, practitionerRow] = await Promise.all([
    admin.from("studios").select("*").eq("id", studioId).maybeSingle(),
    admin.from("services").select("*").eq("id", a.service_id).eq("studio_id", studioId).maybeSingle(),
    admin
      .from("clients")
      .select("name, email, phone, sms_consent_at, sms_opted_out_at")
      .eq("id", a.client_id)
      .eq("studio_id", studioId)
      .maybeSingle(),
    admin
      .from("practitioners")
      .select("display_name, email")
      .eq("id", a.practitioner_id)
      .eq("studio_id", studioId)
      .maybeSingle(),
  ]);
  if (!studioRow.data || !serviceRow.data || !clientRow.data || !practitionerRow.data) return;
  const practitioner = practitionerRow.data as { display_name: string | null; email: string };
  const client = clientRow.data as {
    name: string;
    email: string | null;
    phone: string | null;
    sms_consent_at: string | null;
    sms_opted_out_at: string | null;
  };
  await dispatchBookingNotifications({
    appointment: a,
    service: serviceRow.data as Service,
    studio: studioRow.data as Studio,
    // The TREATING practitioner: the booking is theirs, not the front desk's.
    practitionerName: practitioner.display_name?.trim() || practitioner.email,
    practitionerEmail: practitioner.email,
    clientName: client.name,
    clientEmail: client.email,
    clientPhone: client.phone,
    clientSmsConsentAt: client.sms_consent_at,
    clientSmsOptedOutAt: client.sms_opted_out_at,
    notes: null,
  });
}

export async function moveFrontDeskAppointmentAction(
  _prev: FrontDeskActionState,
  formData: FormData,
): Promise<FrontDeskActionState> {
  const appointmentId = field(formData, "appointment_id");
  const target = field(formData, "practitioner_id");
  const expectedStartsAt = field(formData, "expected_starts_at");
  const expectedEndsAt = field(formData, "expected_ends_at");
  if (!UUID.test(appointmentId) || (target !== "" && !UUID.test(target))) {
    return { ok: false, message: "Appointment not found." };
  }
  const { studio } = await requireReceptionistWithStudio();
  const start = instant(field(formData, "date"), field(formData, "time"), studio.timezone);
  if (!start) return { ok: false, message: "Choose a date and time." };
  if (start.getTime() <= Date.now()) return { ok: false, message: RESULT_COPY.invalid_time };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("receptionist_move_appointment", {
    p_studio_id: studio.id,
    p_appointment_id: appointmentId,
    // Empty = keep the current practitioner, resolved from the LOCKED row.
    p_target_practitioner_id: target === "" ? null : target,
    p_expected_starts_at: expectedStartsAt,
    p_expected_ends_at: expectedEndsAt,
    p_new_starts_at: start.toISOString(),
  });
  if (error) {
    if (error.code === "23P01" || error.code === "HB001") return { ok: false, message: SLOT_TAKEN };
    logDeskError("move", "rpc", error.code);
    return { ok: false, message: "Could not move the appointment. Please try again." };
  }
  const row = (data as Array<{ result: string }> | null)?.[0];
  const kind = row?.result;
  if (kind !== "moved" && kind !== "reassigned" && kind !== "moved_and_reassigned") {
    return { ok: false, message: frontDeskResultMessage(kind) };
  }

  // COMMITTED. The practitioner calendar's own truthful move notification.
  const status = await notifyAppointmentMoved(createAdminClient(), {
    appointmentId,
    studioId: studio.id,
    appOrigin: getRequiredAppOrigin(),
    resultKind: kind as MoveNotificationKind,
  });
  revalidatePath("/front-desk");
  const verb = kind === "reassigned" ? "reassigned" : kind === "moved_and_reassigned" ? "moved and reassigned" : "moved";
  return {
    ok: true,
    message:
      status === "degraded"
        ? `Appointment ${verb}, but the client notification could not be delivered.`
        : `Appointment ${verb}.`,
  };
}

export async function cancelFrontDeskAppointmentAction(
  _prev: FrontDeskActionState,
  formData: FormData,
): Promise<FrontDeskActionState> {
  const appointmentId = field(formData, "appointment_id");
  const reason = field(formData, "reason").slice(0, 500) || null;
  if (!UUID.test(appointmentId)) return { ok: false, message: "Appointment not found." };
  const { receptionist, studio } = await requireReceptionistWithStudio();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("receptionist_cancel_appointment", {
    p_studio_id: studio.id,
    p_appointment_id: appointmentId,
    p_reason: reason,
  });
  if (error) {
    logDeskError("cancel", "rpc", error.code);
    return { ok: false, message: "Could not cancel the appointment. Please try again." };
  }
  if (data === "already_cancelled") {
    revalidatePath("/front-desk");
    return { ok: true, message: "This appointment was already cancelled." };
  }
  if (data !== "cancelled") return { ok: false, message: frontDeskResultMessage(data as string) };

  // COMMITTED. The client's cancellation email, as the practitioner calendar
  // sends it, naming the front desk as the actor.
  try {
    await notifyCancelled(appointmentId, studio.id, receptionist.displayName, reason);
  } catch (e) {
    logDeskError("cancel", `post_commit_${e instanceof Error ? e.name : "unknown"}`, undefined);
  }
  revalidatePath("/front-desk");
  return { ok: true, message: "Appointment cancelled." };
}

async function notifyCancelled(
  appointmentId: string,
  studioId: string,
  actorName: string,
  reason: string | null,
): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("appointments")
    .select("starts_at, duration_minutes, client:clients(name, email), service:services(name), studio:studios(*)")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .maybeSingle();
  const row = data as unknown as {
    starts_at: string;
    duration_minutes: number;
    client: { name: string; email: string | null } | null;
    service: { name: string } | null;
    studio: Studio | null;
  } | null;
  if (!row?.client?.email || !row.studio) return;
  await sendCancellationEmail({
    to: row.client.email,
    recipientName: row.client.name,
    clientName: row.client.name,
    studio: row.studio,
    serviceName: row.service?.name ?? "your appointment",
    durationMinutes: row.duration_minutes,
    startsAt: new Date(row.starts_at),
    actorName,
    actorRole: "receptionist",
    reason,
    isClient: true,
    rebookUrl: `${getRequiredAppOrigin()}/book/${row.studio.slug}`,
  });
}

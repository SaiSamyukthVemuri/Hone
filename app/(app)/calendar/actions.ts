"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAvailableSlots } from "@/lib/booking/slots";
import { generateCancellationToken } from "@/lib/booking/tokens";
import { generateAppointmentToken } from "@/lib/booking/appointment-token";
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
} from "@/lib/email/send-appointment";
import { localDateString } from "@/lib/booking/tz";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

export type BookResult =
  | { ok: true; appointmentId: string }
  | { ok: false; error: string; code?: "slot_taken" };

export async function bookAppointmentForClientAction(
  formData: FormData,
): Promise<BookResult> {
  const clientId = formDataStr(formData, "client_id");
  const serviceId = formDataStr(formData, "service_id");
  const startsAt = formDataStr(formData, "starts_at");
  const notes = formDataStrOrNull(formData, "notes");

  if (!clientId || !serviceId || !startsAt) {
    return { ok: false, error: "Missing fields." };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot book." };
  }

  const supabase = await createClient();

  // Pull service for duration; also confirms it's in this studio.
  const { data: service, error: serviceErr } = await supabase
    .from("services")
    .select("*")
    .eq("id", serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (serviceErr) return { ok: false, error: serviceErr.message };
  if (!service) return { ok: false, error: "Service not found." };

  // Confirm the client belongs to the studio.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, name, email, phone")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) return { ok: false, error: clientErr.message };
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
  const end = new Date(start.getTime() + service.default_duration_minutes * 60_000);

  // Re-verify the slot is still available (race-safe). Use the
  // studio's local date, not the UTC date, so a late-evening booking
  // does not look up the next day's slots.
  const dateStr = localDateString(start, studio.timezone);
  const slots = await getAvailableSlots(
    supabase,
    {
      id: studio.id,
      timezone: studio.timezone,
      default_appointment_duration_minutes:
        studio.default_appointment_duration_minutes,
      buffer_minutes: studio.buffer_minutes,
    },
    dateStr,
    service.default_duration_minutes,
  );
  const isFree = slots.some((s) => new Date(s.start).getTime() === start.getTime());
  if (!isFree) {
    return {
      ok: false,
      error: "That time is no longer available. Please choose another time.",
    };
  }

  const appointmentToken = generateAppointmentToken();
  const { data: created, error: insertErr } = await supabase
    .from("appointments")
    .insert({
      studio_id: studio.id,
      practitioner_id: practitioner.id,
      client_id: clientId,
      service_id: serviceId,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      duration_minutes: service.default_duration_minutes,
      status: "confirmed",
      notes,
      cancellation_token: appointmentToken,
    })
    .select("*")
    .single();
  if (insertErr || !created) {
    // sqlstate 23P01 = exclusion_violation from the
    // no_overlapping_active_appointments_per_studio constraint. The
    // structured code lets the calendar UI surface a toast and
    // refresh the grid without parsing the message string.
    if (insertErr?.code === "23P01") {
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
    return { ok: false, error: insertErr?.message ?? "Insert failed." };
  }

  await supabase.from("appointment_audit").insert({
    appointment_id: created.id,
    actor_type: "practitioner",
    actor_id: practitioner.id,
    action: "created",
    details: { source: "practitioner_ui", notes },
  });

  await dispatchBookingEmails({
    appointment: created,
    service,
    studio,
    practitionerName: practitioner.display_name?.trim() || practitioner.email,
    practitionerEmail: practitioner.email,
    clientName: client.name,
    clientEmail: client.email,
    clientPhone: client.phone,
    notes,
  });

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");

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
    .select("client_id, starts_at, service_id")
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
          studio,
          serviceName: service?.name ?? "your appointment",
          startsAt: new Date(appt.starts_at),
          cancelledBy: practitioner.role === "owner" ? "owner" : "practitioner",
          reason,
          isClient: true,
          rebookUrl: `${APP_ORIGIN}/book/${studio.slug}`,
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
  | { ok: false; error: string };

// P0-1 + P0-3: practitioner-initiated mark complete. Calls the
// service-role-only RPC public.mark_appointment_complete (defined in
// migration 0032) which:
//   * verifies the practitioner is active in the studio,
//   * locks the appointment FOR UPDATE,
//   * refuses any source state other than 'confirmed',
//   * refuses if ends_at is in the future,
//   * writes the appointment_audit row atomically.
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
    return { ok: false, error: error?.message ?? "Could not create client." };
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
    if (error) throw new Error(error.message);
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
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not load last service.",
    };
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
  notes: string | null;
};

async function dispatchBookingEmails(p: DispatchParams) {
  // Prefer the column-based token if the row has one; legacy callers that
  // missed the new path can still produce a working HMAC link.
  const token =
    p.appointment.cancellation_token ??
    generateCancellationToken(p.appointment.id, new Date(p.appointment.starts_at));
  const cancellationUrl = `${APP_ORIGIN}/cancel/${token}`;
  const rescheduleUrl = p.appointment.cancellation_token
    ? `${APP_ORIGIN}/reschedule/${p.appointment.cancellation_token}`
    : null;
  const appointmentUrl = `${APP_ORIGIN}/calendar`;

  if (p.clientEmail && p.studio.send_confirmation_emails) {
    const intake = await ensureIntakeForClient({
      studioId: p.studio.id,
      clientId: p.appointment.client_id,
      appOrigin: APP_ORIGIN,
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
      appBaseUrl: APP_ORIGIN,
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
  });
}

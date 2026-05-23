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
  const end = new Date(start.getTime() + service.default_duration_minutes * 60_000);
  // Snapshot the buffer at booking time so the row carries its own
  // protected window. Matches lib/booking/slots.ts conflict logic.
  const bufferMs = (studio.buffer_minutes ?? 0) * 60_000;
  const blockedStart = new Date(start.getTime() - bufferMs);
  const blockedEnd = new Date(end.getTime() + bufferMs);

  // Re-verify the slot is still available (race-safe).
  const dateStr = start.toISOString().slice(0, 10);
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
    return { ok: false, error: "That slot is no longer available." };
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
      blocked_starts_at: blockedStart.toISOString(),
      blocked_ends_at: blockedEnd.toISOString(),
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
        error: "That slot was just taken. Refresh and pick another time.",
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

  const supabase = await createClient();
  const { data: appt, error: lookupErr } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", appointmentId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.status === "cancelled") return { ok: true };

  const cancelledBy = practitioner.role === "owner" ? "owner" : "practitioner";

  const { error: updateErr } = await supabase
    .from("appointments")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancelled_by: cancelledBy,
      cancellation_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", appointmentId)
    .eq("studio_id", studio.id);
  if (updateErr) return { ok: false, error: updateErr.message };

  await supabase.from("appointment_audit").insert({
    appointment_id: appointmentId,
    actor_type: "practitioner",
    actor_id: practitioner.id,
    action: "cancelled",
    details: { reason, cancelled_by: cancelledBy },
  });

  // Notify the client (with a rebook link). Best effort.
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
    await sendCancellationEmail({
      to: client.email,
      recipientName: client.name,
      studio,
      serviceName: service?.name ?? "your appointment",
      startsAt: new Date(appt.starts_at),
      cancelledBy,
      reason,
      isClient: true,
      rebookUrl: `${APP_ORIGIN}/book/${studio.slug}`,
    });
  }

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  revalidatePath(`/clients/${appt.client_id}`);
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

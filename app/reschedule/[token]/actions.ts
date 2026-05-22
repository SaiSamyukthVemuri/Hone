"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyCancellationToken } from "@/lib/booking/tokens";
import { generateAppointmentToken } from "@/lib/booking/appointment-token";
import { getAvailableSlots, type Slot } from "@/lib/booking/slots";
import { sendBookingConfirmationToClient } from "@/lib/email/send-appointment";
import { ensureIntakeForClient } from "@/lib/intake/queries";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

async function resolveAppointmentIdFromToken(
  token: string,
): Promise<
  | { ok: true; appointment_id: string }
  | { ok: false; error: "expired" | "invalid" }
> {
  if (!token) return { ok: false, error: "invalid" };
  const admin = createAdminClient();
  const { data: byColumn } = await admin
    .from("appointments")
    .select("id")
    .eq("cancellation_token", token)
    .maybeSingle();
  if (byColumn) return { ok: true, appointment_id: byColumn.id };
  const v = verifyCancellationToken(token);
  if (v.ok) return { ok: true, appointment_id: v.appointment_id };
  return { ok: false, error: v.error === "expired" ? "expired" : "invalid" };
}

export type RescheduleSummary = {
  appointmentId: string;
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  studioId: string;
  studioName: string;
  studioTimezone: string;
  startsAt: string;
  status: "confirmed" | "cancelled" | "completed" | "no_show";
};

export type FetchRescheduleResult =
  | { ok: true; summary: RescheduleSummary }
  | { ok: false; error: string };

export async function fetchAppointmentForRescheduleAction(
  token: string,
): Promise<FetchRescheduleResult> {
  const resolved = await resolveAppointmentIdFromToken(token);
  if (!resolved.ok) {
    return {
      ok: false,
      error:
        resolved.error === "expired"
          ? "This reschedule link has expired."
          : "This reschedule link is no longer valid.",
    };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select(
      "id, status, starts_at, duration_minutes, service_id, service:services(id, name, default_duration_minutes), studio:studios(id, name, timezone)",
    )
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Appointment not found." };

  type Joined = {
    id: string;
    status: "confirmed" | "cancelled" | "completed" | "no_show";
    starts_at: string;
    duration_minutes: number;
    service_id: string | null;
    service:
      | { id: string; name: string; default_duration_minutes: number }
      | Array<{ id: string; name: string; default_duration_minutes: number }>
      | null;
    studio:
      | { id: string; name: string; timezone: string }
      | Array<{ id: string; name: string; timezone: string }>
      | null;
  };
  const row = data as unknown as Joined;
  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  const service = pick(row.service);
  const studio = pick(row.studio);
  if (!service || !studio) {
    return { ok: false, error: "Appointment is missing service or studio." };
  }

  return {
    ok: true,
    summary: {
      appointmentId: row.id,
      serviceId: service.id,
      serviceName: service.name,
      durationMinutes: row.duration_minutes,
      studioId: studio.id,
      studioName: studio.name,
      studioTimezone: studio.timezone,
      startsAt: row.starts_at,
      status: row.status,
    },
  };
}

export async function fetchRescheduleSlotsAction(params: {
  token: string;
  date: string;
}): Promise<{ ok: true; slots: Slot[] } | { ok: false; error: string }> {
  const resolved = await resolveAppointmentIdFromToken(params.token);
  if (!resolved.ok) {
    return { ok: false, error: "This reschedule link is no longer valid." };
  }
  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select(
      "id, duration_minutes, service:services(default_duration_minutes), studio:studios(id, timezone, default_appointment_duration_minutes, buffer_minutes)",
    )
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };

  type J = {
    id: string;
    duration_minutes: number;
    service:
      | { default_duration_minutes: number }
      | { default_duration_minutes: number }[]
      | null;
    studio:
      | {
          id: string;
          timezone: string;
          default_appointment_duration_minutes: number;
          buffer_minutes: number;
        }
      | {
          id: string;
          timezone: string;
          default_appointment_duration_minutes: number;
          buffer_minutes: number;
        }[]
      | null;
  };
  const r = appt as unknown as J;
  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  const svc = pick(r.service);
  const stu = pick(r.studio);
  if (!stu) return { ok: false, error: "Studio missing." };

  const slots = await getAvailableSlots(
    admin,
    {
      id: stu.id,
      timezone: stu.timezone,
      default_appointment_duration_minutes:
        stu.default_appointment_duration_minutes,
      buffer_minutes: stu.buffer_minutes,
    },
    params.date,
    svc?.default_duration_minutes ?? r.duration_minutes,
  );
  return { ok: true, slots };
}

export type RescheduleResult =
  | { ok: true; newAppointmentId: string }
  | { ok: false; error: string };

export async function rescheduleAppointmentViaTokenAction(formData: FormData): Promise<
  RescheduleResult
> {
  const token = stringOrEmpty(formData.get("token"));
  const newStartsAt = stringOrEmpty(formData.get("starts_at"));
  if (!token) return { ok: false, error: "Missing token." };
  if (!newStartsAt) return { ok: false, error: "Pick a time." };

  const resolved = await resolveAppointmentIdFromToken(token);
  if (!resolved.ok) {
    return { ok: false, error: "This reschedule link is no longer valid." };
  }

  const admin = createAdminClient();
  const { data: existing, error: lookupErr } = await admin
    .from("appointments")
    .select(
      "id, studio_id, practitioner_id, client_id, service_id, status, starts_at, duration_minutes",
    )
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!existing) return { ok: false, error: "Appointment not found." };
  if (existing.status !== "confirmed") {
    return { ok: false, error: "This appointment can no longer be rescheduled." };
  }
  if (new Date(existing.starts_at).getTime() < Date.now()) {
    return { ok: false, error: "This appointment has already passed." };
  }

  const start = new Date(newStartsAt);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: "Invalid time." };
  }
  const end = new Date(start.getTime() + existing.duration_minutes * 60_000);

  // Re-verify the new slot is still free.
  const { data: studioRow } = await admin
    .from("studios")
    .select(
      "id, timezone, default_appointment_duration_minutes, buffer_minutes, name, send_confirmation_emails",
    )
    .eq("id", existing.studio_id)
    .maybeSingle();
  if (!studioRow) return { ok: false, error: "Studio missing." };

  const dateStr = start.toISOString().slice(0, 10);
  const slots = await getAvailableSlots(
    admin,
    {
      id: studioRow.id,
      timezone: studioRow.timezone,
      default_appointment_duration_minutes:
        studioRow.default_appointment_duration_minutes,
      buffer_minutes: studioRow.buffer_minutes,
    },
    dateStr,
    existing.duration_minutes,
  );
  const free = slots.some(
    (s) => new Date(s.start).getTime() === start.getTime(),
  );
  if (!free) {
    return { ok: false, error: "That slot was just taken. Pick another." };
  }

  // Cancel the original, create the new one with a fresh token.
  const cancelStamp = new Date().toISOString();
  const { error: cancelErr } = await admin
    .from("appointments")
    .update({
      status: "cancelled",
      cancelled_at: cancelStamp,
      cancelled_by: "client",
      cancellation_reason: "Rescheduled via email link",
      updated_at: cancelStamp,
    })
    .eq("id", existing.id);
  if (cancelErr) return { ok: false, error: cancelErr.message };

  const newToken = generateAppointmentToken();
  const { data: created, error: insertErr } = await admin
    .from("appointments")
    .insert({
      studio_id: existing.studio_id,
      practitioner_id: existing.practitioner_id,
      client_id: existing.client_id,
      service_id: existing.service_id,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      duration_minutes: existing.duration_minutes,
      status: "confirmed",
      notes: null,
      cancellation_token: newToken,
    })
    .select("*")
    .single();
  if (insertErr || !created) {
    // Roll back the cancel so the client isn't left with no appointment.
    await admin
      .from("appointments")
      .update({
        status: "confirmed",
        cancelled_at: null,
        cancelled_by: null,
        cancellation_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    return {
      ok: false,
      error: insertErr?.message ?? "Failed to create the rescheduled appointment.",
    };
  }

  await admin.from("appointment_audit").insert([
    {
      appointment_id: existing.id,
      actor_type: "client",
      actor_id: null,
      action: "cancelled",
      details: { reason: "rescheduled", new_appointment_id: created.id },
    },
    {
      appointment_id: created.id,
      actor_type: "client",
      actor_id: null,
      action: "created",
      details: { source: "reschedule_link", original_appointment_id: existing.id },
    },
  ]);

  // Send a fresh confirmation email for the new appointment.
  const { data: clientRow } = await admin
    .from("clients")
    .select("name, email")
    .eq("id", existing.client_id)
    .maybeSingle();
  const { data: serviceRow } = existing.service_id
    ? await admin
        .from("services")
        .select("name, default_duration_minutes, pre_care_instructions")
        .eq("id", existing.service_id)
        .maybeSingle()
    : { data: null };
  const { data: ownerRow } = await admin
    .from("practitioners")
    .select("display_name, email")
    .eq("studio_id", existing.studio_id)
    .eq("active", true)
    .eq("role", "owner")
    .maybeSingle();

  if (clientRow?.email && studioRow.send_confirmation_emails) {
    const cancellationUrl = `${APP_ORIGIN}/cancel/${newToken}`;
    const rescheduleUrl = `${APP_ORIGIN}/reschedule/${newToken}`;
    const intake = await ensureIntakeForClient({
      studioId: existing.studio_id,
      clientId: existing.client_id,
      appOrigin: APP_ORIGIN,
    });
    try {
      const { data: studioFull } = await admin
        .from("studios")
        .select("*")
        .eq("id", existing.studio_id)
        .single();
      if (studioFull) {
        await sendBookingConfirmationToClient({
          appointment: created,
          service: serviceRow,
          studio: studioFull,
          practitionerDisplayName:
            ownerRow?.display_name?.trim() || ownerRow?.email || studioFull.name,
          clientName: clientRow.name,
          clientEmail: clientRow.email,
          cancellationUrl,
          rescheduleUrl,
          intakeUrl: intake?.url ?? null,
          appBaseUrl: APP_ORIGIN,
        });
        await admin
          .from("appointments")
          .update({
            confirmation_sent_at: new Date().toISOString(),
            confirmation_send_attempts: 1,
          })
          .eq("id", created.id);
      }
    } catch (err) {
      console.error("Reschedule confirmation email failed:", err);
    }
  }

  return { ok: true, newAppointmentId: created.id };
}

function stringOrEmpty(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyCancellationToken } from "@/lib/booking/tokens";
import { generateAppointmentToken } from "@/lib/booking/appointment-token";
import { getAvailableSlots, type Slot } from "@/lib/booking/slots";
import {
  logEmailFailure,
  recordEmailAttempt,
  sendBookingConfirmationToClient,
} from "@/lib/email/send-appointment";
import { ensureIntakeForClient } from "@/lib/intake/queries";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";

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
  | { ok: false; error: string; code?: "slot_taken" };

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

  // Single-transaction reschedule via the reschedule_appointment RPC
  // (migration 0029). Cancels the original row, inserts the
  // replacement, and writes both audit rows atomically. If anything
  // fails, including the exclusion constraint catching a slot race,
  // Postgres rolls back the entire transaction and the original
  // appointment stays confirmed.
  const newToken = generateAppointmentToken();
  const { data: rpcData, error: rpcErr } = await admin.rpc(
    "reschedule_appointment",
    {
      p_original_appointment_id: existing.id,
      p_new_starts_at: start.toISOString(),
      p_new_ends_at: end.toISOString(),
      p_new_duration_minutes: existing.duration_minutes,
      p_new_cancellation_token: newToken,
    },
  );

  if (rpcErr) {
    if (rpcErr.code === "23P01") {
      console.error(
        JSON.stringify({
          event: "booking_slot_collision",
          studioId: existing.studio_id,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          source: "reschedule",
          timestamp: new Date().toISOString(),
        }),
      );
      return {
        ok: false,
        error: "That slot was just taken. Pick another.",
        code: "slot_taken",
      };
    }
    return { ok: false, error: rpcErr.message };
  }

  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (!row || typeof row.result !== "string") {
    return { ok: false, error: "Unexpected response from server." };
  }

  if (row.result !== "success") {
    switch (row.result) {
      case "appointment_not_found":
        return { ok: false, error: "Appointment not found." };
      case "appointment_not_reschedulable":
        return {
          ok: false,
          error: "This appointment can no longer be rescheduled.",
        };
      case "invalid_time_range":
        return { ok: false, error: "Invalid time." };
      default:
        return { ok: false, error: "Unexpected error." };
    }
  }

  const newAppointmentId = row.new_appointment_id as string;

  // Re-fetch the newly inserted row so the email-builder has the
  // complete appointment shape. The RPC returns only the id.
  const { data: created, error: fetchErr } = await admin
    .from("appointments")
    .select("*")
    .eq("id", newAppointmentId)
    .single();
  if (fetchErr || !created) {
    return {
      ok: false,
      error: fetchErr?.message ?? "Could not load the rescheduled appointment.",
    };
  }

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
        const treatmentTimeLine = studioFull.show_treatment_time_to_clients
          ? buildTreatmentTimeLine({
              enabled: true,
              clientFirstName:
                clientRow.name.split(/\s+/)[0] || clientRow.name,
              context: await getTreatmentTimeContextForEmail(
                existing.studio_id,
                existing.client_id,
              ),
            })
          : null;
        // Truthful reporting: stamp confirmation_sent_at only when Resend
        // actually delivered, not just when we called it.
        const result = await sendBookingConfirmationToClient({
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
          treatmentTimeLine,
          appBaseUrl: APP_ORIGIN,
        });
        await recordEmailAttempt(admin, created.id, "confirmation", result.ok);
        if (!result.ok) {
          logEmailFailure({
            appointmentId: created.id,
            emailType: "confirmation",
            error: result.error,
            retryable: result.retryable,
            attemptNumber: 1,
          });
        }
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "reschedule_confirmation_unexpected_error",
          appointmentId: created.id,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  return { ok: true, newAppointmentId: created.id };
}

function stringOrEmpty(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

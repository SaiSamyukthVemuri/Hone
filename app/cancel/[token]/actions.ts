"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyCancellationToken } from "@/lib/booking/tokens";
import { sendCancellationEmail } from "@/lib/email/send-appointment";

export type PublicCancelResult =
  | { ok: true; alreadyCancelled?: boolean }
  | { ok: false; error: string };

export async function publicCancelAppointmentAction(
  formData: FormData,
): Promise<PublicCancelResult> {
  const token = strOrEmpty(formData.get("token"));
  const reason = strOrNull(formData.get("reason"));
  if (!token) return { ok: false, error: "Missing token." };

  const v = verifyCancellationToken(token);
  if (!v.ok) {
    return {
      ok: false,
      error:
        v.error === "expired"
          ? "This cancellation link has expired."
          : "This cancellation link is no longer valid.",
    };
  }

  const admin = createAdminClient();
  const { data: appt, error: lookupErr } = await admin
    .from("appointments")
    .select("*, client:clients(name, email), service:services(name), studio:studios(*)")
    .eq("id", v.appointment_id)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!appt) return { ok: false, error: "Appointment not found." };

  if (appt.status === "cancelled") {
    return { ok: true, alreadyCancelled: true };
  }

  const { error: updateErr } = await admin
    .from("appointments")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancelled_by: "client",
      cancellation_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", v.appointment_id);
  if (updateErr) return { ok: false, error: updateErr.message };

  await admin.from("appointment_audit").insert({
    appointment_id: v.appointment_id,
    actor_type: "client",
    actor_id: null,
    action: "cancelled",
    details: { reason, source: "signed_link" },
  });

  // Notify studio owner.
  const { data: owner } = await admin
    .from("practitioners")
    .select("display_name, email")
    .eq("studio_id", appt.studio_id)
    .eq("active", true)
    .eq("role", "owner")
    .maybeSingle();
  if (owner?.email) {
    await sendCancellationEmail({
      to: owner.email,
      recipientName: owner.display_name?.trim() || owner.email,
      studio: appt.studio,
      serviceName: appt.service?.name ?? "Appointment",
      startsAt: new Date(appt.starts_at),
      cancelledBy: "client",
      reason,
      isClient: false,
    });
  }

  return { ok: true };
}

export type AppointmentSummary = {
  studioName: string;
  studioTimezone: string;
  serviceName: string;
  startsAt: string;
  clientName: string;
  alreadyCancelled: boolean;
};

export async function fetchAppointmentForCancelAction(
  token: string,
): Promise<{ ok: true; summary: AppointmentSummary } | { ok: false; error: string }> {
  const v = verifyCancellationToken(token);
  if (!v.ok) {
    return {
      ok: false,
      error:
        v.error === "expired"
          ? "This cancellation link has expired."
          : "This cancellation link is no longer valid.",
    };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select(
      "id, status, starts_at, studio:studios(name, timezone), service:services(name), client:clients(name)",
    )
    .eq("id", v.appointment_id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Appointment not found." };

  // The relation shape from Supabase types as array; pick first.
  type Joined = {
    id: string;
    status: string;
    starts_at: string;
    studio: { name: string; timezone: string } | { name: string; timezone: string }[] | null;
    service: { name: string } | { name: string }[] | null;
    client: { name: string } | { name: string }[] | null;
  };
  const row = data as unknown as Joined;
  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  const studio = pick(row.studio);
  const service = pick(row.service);
  const client = pick(row.client);

  return {
    ok: true,
    summary: {
      studioName: studio?.name ?? "studio",
      studioTimezone: studio?.timezone ?? "UTC",
      serviceName: service?.name ?? "Appointment",
      startsAt: row.starts_at,
      clientName: client?.name ?? "",
      alreadyCancelled: row.status === "cancelled",
    },
  };
}

function strOrEmpty(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}
function strOrNull(v: FormDataEntryValue | null): string | null {
  const s = strOrEmpty(v);
  return s.length === 0 ? null : s;
}

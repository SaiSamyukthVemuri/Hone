"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStudioBySlug } from "@/lib/booking/queries";
import { getAvailableSlots, type Slot } from "@/lib/booking/slots";
import { generateCancellationToken } from "@/lib/booking/tokens";
import {
  sendBookingConfirmationToClient,
  sendBookingNotificationToPractitioner,
} from "@/lib/email/send-appointment";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function fetchPublicSlotsAction(params: {
  slug: string;
  serviceId: string;
  date: string;
}): Promise<{ ok: true; slots: Slot[] } | { ok: false; error: string }> {
  const studio = await getStudioBySlug(params.slug);
  if (!studio) return { ok: false, error: "Studio not found." };

  const admin = createAdminClient();
  const { data: service, error } = await admin
    .from("services")
    .select("default_duration_minutes")
    .eq("id", params.serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!service) return { ok: false, error: "Service not found." };

  const slots = await getAvailableSlots(
    admin,
    {
      id: studio.id,
      timezone: studio.timezone,
      default_appointment_duration_minutes:
        studio.default_appointment_duration_minutes,
      buffer_minutes: studio.buffer_minutes,
    },
    params.date,
    service.default_duration_minutes,
  );
  return { ok: true, slots };
}

export type PublicBookResult =
  | { ok: true; appointmentId: string }
  | { ok: false; error: string };

export async function publicBookAppointmentAction(formData: FormData): Promise<PublicBookResult> {
  const slug = trimmed(formData.get("slug"));
  const serviceId = trimmed(formData.get("service_id"));
  const startsAtRaw = trimmed(formData.get("starts_at"));
  const name = trimmed(formData.get("name"));
  const email = trimmed(formData.get("email")).toLowerCase();
  const phone = nullable(formData.get("phone"));
  const notes = nullable(formData.get("notes"));

  if (!slug || !serviceId || !startsAtRaw)
    return { ok: false, error: "Missing booking details." };
  if (!name) return { ok: false, error: "Your name is required." };
  if (!EMAIL_RE.test(email))
    return { ok: false, error: "Enter a valid email address." };

  const studio = await getStudioBySlug(slug);
  if (!studio) return { ok: false, error: "Studio not found." };

  const start = new Date(startsAtRaw);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: "Invalid time." };
  }

  const admin = createAdminClient();

  const { data: service } = await admin
    .from("services")
    .select("*")
    .eq("id", serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (!service) return { ok: false, error: "Service no longer available." };

  // Re-verify slot is free.
  const dateStr = start.toISOString().slice(0, 10);
  const slots = await getAvailableSlots(
    admin,
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
  const free = slots.some((s) => new Date(s.start).getTime() === start.getTime());
  if (!free) return { ok: false, error: "That slot was just taken. Pick another." };

  const end = new Date(start.getTime() + service.default_duration_minutes * 60_000);

  // Match existing client by email within this studio, else create.
  const { data: existingClient } = await admin
    .from("clients")
    .select("id, name, email, phone")
    .eq("studio_id", studio.id)
    .ilike("email", email)
    .maybeSingle();

  let clientId: string;
  let clientName: string;
  let clientPhone: string | null;
  if (existingClient) {
    clientId = existingClient.id;
    clientName = existingClient.name;
    clientPhone = existingClient.phone ?? phone;
    // Backfill phone if newly provided.
    if (phone && !existingClient.phone) {
      await admin.from("clients").update({ phone }).eq("id", clientId);
      clientPhone = phone;
    }
  } else {
    const { data: createdClient, error: clientErr } = await admin
      .from("clients")
      .insert({
        studio_id: studio.id,
        name,
        email,
        phone,
      })
      .select("id, name, email, phone")
      .single();
    if (clientErr || !createdClient) {
      return { ok: false, error: clientErr?.message ?? "Failed to save client." };
    }
    clientId = createdClient.id;
    clientName = createdClient.name;
    clientPhone = createdClient.phone;
  }

  // Find the owner practitioner to attribute the appointment to + notify.
  const { data: owner } = await admin
    .from("practitioners")
    .select("id, display_name, email")
    .eq("studio_id", studio.id)
    .eq("active", true)
    .eq("role", "owner")
    .maybeSingle();

  const { data: created, error: insertErr } = await admin
    .from("appointments")
    .insert({
      studio_id: studio.id,
      practitioner_id: owner?.id ?? null,
      client_id: clientId,
      service_id: serviceId,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      duration_minutes: service.default_duration_minutes,
      status: "confirmed",
      notes,
    })
    .select("*")
    .single();
  if (insertErr || !created) {
    return { ok: false, error: insertErr?.message ?? "Failed to book." };
  }

  await admin.from("appointment_audit").insert({
    appointment_id: created.id,
    actor_type: "client",
    actor_id: null,
    action: "created",
    details: { source: "public_booking", email, notes },
  });

  // Emails.
  const cancelToken = generateCancellationToken(created.id, new Date(created.starts_at));
  const cancellationUrl = `${APP_ORIGIN}/cancel/${cancelToken}`;
  await sendBookingConfirmationToClient({
    appointment: created,
    service,
    studio,
    practitionerDisplayName:
      owner?.display_name?.trim() || owner?.email || studio.name,
    clientName,
    clientEmail: email,
    cancellationUrl,
    appBaseUrl: APP_ORIGIN,
  });
  if (owner?.email) {
    await sendBookingNotificationToPractitioner({
      appointment: created,
      service,
      studio,
      practitionerName:
        owner.display_name?.trim() || owner.email || "Practitioner",
      practitionerEmail: owner.email,
      clientName,
      clientEmail: email,
      clientPhone,
      notes,
      appointmentUrl: `${APP_ORIGIN}/calendar/${created.id}`,
    });
  }

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  return { ok: true, appointmentId: created.id };
}

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
function nullable(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value);
  return t.length === 0 ? null : t;
}

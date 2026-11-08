// HON-7. The practitioner bell for a cancellation, from every path that cancels.
//
// WHO IS NOTIFIED. The studio's active owners, one row each (practitioner_id = that owner), EXCEPT the person who cancelled: an actor is never
// notified of their own action. A client cancel through the link has no actor, so every owner is notified. The bell reader shows an
// appointment_cancelled row only to its recipient (lib/notifications/owner-only-events.ts), and each row has its own read_at.
//
// WHY THIS IS NOT INLINE IN THE ACTIONS. It used to be written from inside the public cancel action's joined appointment read (appointments +
// studios(*) + clients(name)). A null join, or a throw while composing the owner email, skipped it with no trace, so a committed cancellation
// could leave no bell. Here it depends only on the committed appointment id: each display field comes from its own small read and degrades to
// neutral wording, and the row is written regardless.
//
// EXACTLY ONCE. Each row carries dedupe_key appointment_cancelled:<appointment_id>:<recipient_id>, so a retry or a client cancel racing a staff
// cancel conflicts on the 0154 unique index (23505 = already recorded). Both cancel commands also refuse a non-confirmed appointment.
//
// HARD CONTRACT: never throws and never awaits the insert (the recorder is fire-and-forget), so a failure here cannot undo or delay the cancel.
// RLS still lets any studio member read every bell row through the API; that limit is the HELD policy migration, not this module.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordPractitionerNotification } from "@/lib/notifications/practitioner-notifications";
import { localTimeString12h } from "@/lib/booking/tz";

export const CANCEL_DEDUPE_PREFIX = "appointment_cancelled:";

type Row = Record<string, unknown> | null;

async function readOne(admin: SupabaseClient, table: string, columns: string, id: string): Promise<Row> {
  try {
    const { data } = await admin.from(table).select(columns).eq("id", id).maybeSingle();
    return data && typeof data === "object" ? (data as unknown as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readOwners(admin: SupabaseClient, studioId: string): Promise<Array<{ id: string }>> {
  try {
    const { data } = await admin
      .from("practitioners")
      .select("id")
      .eq("studio_id", studioId)
      .eq("active", true)
      .eq("role", "owner");
    return Array.isArray(data) ? data.filter((r): r is { id: string } => typeof r?.id === "string") : [];
  } catch {
    return [];
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function dayLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
}

export async function recordAppointmentCancelNotifications(
  admin: SupabaseClient,
  input: {
    appointmentId: string;
    studioId: string | null;
    reasonLabel: string | null;
    // The practitioner who cancelled in the app, or null for a client's cancel through the link.
    actorPractitionerId: string | null;
  },
): Promise<void> {
  try {
    const appt = await readOne(admin, "appointments", "studio_id, client_id, practitioner_id, starts_at, service_id", input.appointmentId);
    const studioId = input.studioId ?? str(appt?.studio_id);
    // The table requires a studio. Without one there is nothing safe to write.
    if (!studioId) return;
    const clientId = str(appt?.client_id);
    const serviceId = str(appt?.service_id);
    const [client, service, studio, actor, owners] = await Promise.all([
      clientId ? readOne(admin, "clients", "name", clientId) : null,
      serviceId ? readOne(admin, "services", "name", serviceId) : null,
      readOne(admin, "studios", "timezone", studioId),
      input.actorPractitionerId ? readOne(admin, "practitioners", "display_name, email", input.actorPractitionerId) : null,
      readOwners(admin, studioId),
    ]);
    const clientName = str(client?.name);
    const what = str(service?.name) ?? "an appointment";
    const tz = str(studio?.timezone);
    const startsAt = str(appt?.starts_at) ? new Date(str(appt?.starts_at) as string) : null;
    let when = "";
    if (tz && startsAt && !Number.isNaN(startsAt.getTime())) {
      try {
        when = ` on ${dayLabel(startsAt, tz)} at ${localTimeString12h(startsAt, tz)}`;
      } catch {
        when = "";
      }
    }
    const reason = input.reasonLabel ? ` Reason: ${input.reasonLabel}.` : "";
    // A staff cancel names the staff member, the client and the service. A client's own cancel names the client.
    const body = input.actorPractitionerId
      ? `${str(actor?.display_name) ?? str(actor?.email) ?? "A team member"} cancelled ${clientName ? `${clientName}'s ` : "a client's "}${what}${when}.${reason}`
      : `${clientName ?? "A client"} cancelled ${what}${when}.${reason}`;

    const base = {
      studioId,
      eventType: "appointment_cancelled" as const,
      title: "Appointment cancelled",
      body,
      appointmentId: input.appointmentId,
      clientId,
      href: `/calendar/${input.appointmentId}`,
    };
    const recipients = owners.filter((o) => o.id !== input.actorPractitionerId);
    if (recipients.length > 0) {
      for (const owner of recipients) {
        recordPractitionerNotification({ ...base, practitionerId: owner.id, dedupeKey: `${CANCEL_DEDUPE_PREFIX}${input.appointmentId}:${owner.id}` });
      }
      return;
    }
    // No owner could be established. Only an actorless (client) cancel falls back to one studio-wide row; with an actor, a studio-wide row
    // could be seen by the very person who must not be notified, and the actor is not an owner we can prove here, so write nothing.
    if (!input.actorPractitionerId) {
      recordPractitionerNotification({ ...base, practitionerId: null, dedupeKey: `${CANCEL_DEDUPE_PREFIX}${input.appointmentId}:studio` });
    }
  } catch {
    // The cancellation is already committed; the bell is best effort and must never surface.
  }
}

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
// EXACTLY ONCE PER CANCELLATION. Each row carries dedupe_key appointment_cancelled:<appointment_id>:<recipient_id>:<occurrence>, so a retry or a client
// cancel racing a staff cancel conflicts on the 0154 unique index (23505 = already recorded). Both cancel commands also refuse a non-confirmed appointment.
//
// THE OCCURRENCE is the appointment's own cancelled_at, as committed. Every cancel command stamps it, and revert_appointment_outcome (0220) clears it
// and restores the appointment to confirmed while leaving the bell rows in place. So the SAME cancellation always reads the same cancelled_at (a retry
// reads the committed row, not the clock), while a cancel after a restore stamps a new one and gets a new key instead of being dropped as a "retry".
// It is read at write time, after the commit. If it cannot be read the occurrence is "na": that is the old behaviour (one row per appointment and
// owner), chosen over dropping the bell. The reader looks only at the prefix, so legacy rows stay studio-wide and new rows stay per-recipient.
//
// HARD CONTRACT: never throws, so a failure here cannot undo the cancel. It AWAITS the insert (the fire-and-forget recorder detached it, and a
// serverless function can return before a detached write runs, which drops the bell silently), so it resolves only after every insert was attempted.
// The free-text reason is excluded from the bell; the client's chosen reason LABEL (a fixed list) is included on a client cancel.
// RLS still lets any studio member read every bell row through the API; that limit is the HELD policy migration, not this module.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordPractitionerNotificationAndWait } from "@/lib/notifications/practitioner-notifications";
import { dbErrorCode } from "@/lib/logging/error-class";
import { localTimeString12h } from "@/lib/booking/tz";

import { CANCEL_RECIPIENT_KEY_PREFIX } from "@/lib/notifications/owner-only-events";

// The reader gives recipient semantics to rows with this prefix only (owner-only-events.ts); legacy cancellation rows stay studio-wide.
export const CANCEL_DEDUPE_PREFIX = CANCEL_RECIPIENT_KEY_PREFIX;

type Row = Record<string, unknown> | null;

async function readOne(admin: SupabaseClient, table: string, columns: string, id: string): Promise<Row> {
  try {
    const { data } = await admin.from(table).select(columns).eq("id", id).maybeSingle();
    return data && typeof data === "object" ? (data as unknown as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// An ERROR is not an EMPTY list: on an error nothing is written (no fallback row), and only a PII-free code is logged.
async function readOwners(admin: SupabaseClient, studioId: string): Promise<{ ok: true; owners: Array<{ id: string }> } | { ok: false }> {
  try {
    const { data, error } = await admin
      .from("practitioners")
      .select("id")
      .eq("studio_id", studioId)
      .eq("active", true)
      .eq("role", "owner");
    if (error || !Array.isArray(data)) {
      logOwnerReadFailure(error ? dbErrorCode(error) : "no_rows_payload");
      return { ok: false };
    }
    return { ok: true, owners: data.filter((r): r is { id: string } => typeof r?.id === "string") };
  } catch {
    logOwnerReadFailure("threw");
    return { ok: false };
  }
}

function logOwnerReadFailure(code: string): void {
  try {
    console.error(JSON.stringify({ event: "cancel_bell_owner_read_failed", code, timestamp: new Date().toISOString() }));
  } catch {
    // best effort
  }
}

// Epoch milliseconds of the committed cancelled_at, so the same instant always renders the same text whatever offset the driver used.
function occurrenceOf(v: unknown): string {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? String(t) : "na";
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
    const appt = await readOne(admin, "appointments", "studio_id, client_id, practitioner_id, starts_at, service_id, cancelled_at", input.appointmentId);
    const studioId = input.studioId ?? str(appt?.studio_id);
    // The table requires a studio. Without one there is nothing safe to write.
    if (!studioId) return;
    const clientId = str(appt?.client_id);
    const serviceId = str(appt?.service_id);
    const [client, service, studio, actor, owners] = await Promise.all([
      clientId ? readOne(admin, "clients", "name", clientId) : null,
      serviceId ? readOne(admin, "services", "name", serviceId) : null,
      readOne(admin, "studios", "timezone", studioId),
      input.actorPractitionerId ? readOne(admin, "practitioners", "display_name", input.actorPractitionerId) : null,
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
    const occurrence = occurrenceOf(appt?.cancelled_at);
    const reason = input.reasonLabel ? ` Reason: ${input.reasonLabel}.` : "";
    // A staff cancel names the staff member, the client and the service. A client's own cancel names the client.
    const body = input.actorPractitionerId
      ? `${str(actor?.display_name) ?? "A team member"} cancelled ${clientName ? `${clientName}'s ` : "a client's "}${what}${when}.${reason}`
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
    // On an owner-read ERROR write nothing at all: neither a per-owner row nor the studio-wide fallback.
    if (!owners.ok) return;
    const recipients = owners.owners.filter((o) => o.id !== input.actorPractitionerId);
    if (recipients.length > 0) {
      await Promise.all(
        recipients.map((owner) =>
          recordPractitionerNotificationAndWait({ ...base, practitionerId: owner.id, dedupeKey: `${CANCEL_DEDUPE_PREFIX}${input.appointmentId}:${owner.id}:${occurrence}` }),
        ),
      );
      return;
    }
    // The read succeeded and the studio has NO active owner (not expected for a live studio). Only an actorless (client) cancel then falls back to one
    // studio-wide row, which the reader shows to owners only; with an actor, a studio-wide row could reach the very person who must not be notified.
    if (!input.actorPractitionerId) {
      await recordPractitionerNotificationAndWait({ ...base, practitionerId: null, dedupeKey: `${CANCEL_DEDUPE_PREFIX}${input.appointmentId}:studio:${occurrence}` });
    }
  } catch {
    // The cancellation is already committed; the bell is best effort and must never surface.
  }
}

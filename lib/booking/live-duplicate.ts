import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/** The database's own rule for the same thing: one live appointment per client, service and exact start. */
export const LIVE_REPEAT_INDEX = "appointments_one_live_per_client_service_start";

/**
 * Is this error the database refusing a SECOND live appointment for the same client, service and start? A write that loses to that rule is a repeat of a
 * booking that already exists, not a failure: callers answer it the way they answer a taken slot (or, in-app, with the existing appointment). Matched
 * on the SQLSTATE AND the rule's name, so no other unique violation is ever read as a repeat.
 */
export function isLiveRepeatViolation(err: { code?: string | null; message?: string | null; details?: string | null } | null | undefined): boolean {
  if (!err || err.code !== "23505") return false;
  return `${err.message ?? ""} ${err.details ?? ""}`.includes(LIVE_REPEAT_INDEX);
}

// A RETRY OR DOUBLE SUBMIT OF ONE BOOKING MUST NOT BECOME A SECOND BOOKING.
//
// WHAT THIS IS. Before a booking is written, ask whether the same client already holds a LIVE appointment for the same service at the exact same
// start. If so, the request is a repeat of a booking that already exists: nothing more is written and the caller answers with the existing one.
//
// WHAT THIS IS NOT. It does not decide whether a booking is allowed. A first request still goes through every eligibility, permission, availability
// and slot check and through the command that writes it; this only short-circuits a request that repeats a booking those checks already accepted.
// A refusal is never hidden by it, because a refused request has no appointment to find.
//
// IT NARROWS THE RACE, IT DOES NOT CLOSE IT. The read and the write are two statements. Two requests that both read before either writes still
// both write. A repeat that arrives after the first has committed (a retry after a lost answer, a second click after the first finished) is caught;
// a perfectly simultaneous pair is not, because only the database can serialise those. Closing that needs a rule inside the write command itself.
//
// LIVE means status `confirmed`. A cancelled, completed or no-show appointment is history, not a booking in force, so booking the same time again
// after a cancellation is an ordinary new booking.

export type LiveDuplicateLookup =
  | { state: "none" }
  | { state: "found"; appointmentId: string }
  // The read itself failed. NOT "none": the caller decides, and must not treat an unreadable answer as permission to write twice.
  | { state: "unreadable" };

export async function findLiveDuplicateAppointment(
  admin: SupabaseClient,
  q: {
    studioId: string;
    clientId: string;
    serviceId: string;
    /** The exact instant, as an ISO string. */
    startsAtIso: string;
    /** Only when the caller names a practitioner (an in-app booking). A client booking names none, and a repeat may have been given to another practitioner. */
    practitionerId?: string | null;
  },
): Promise<LiveDuplicateLookup> {
  // A look-up that THROWS (a dropped connection) is as unreadable as one that returns an error: the caller falls through to the normal write.
  try {
    let query = admin
      .from("appointments")
      .select("id")
      .eq("studio_id", q.studioId)
      .eq("client_id", q.clientId)
      .eq("service_id", q.serviceId)
      .eq("starts_at", q.startsAtIso)
      .eq("status", "confirmed");
    if (q.practitionerId) query = query.eq("practitioner_id", q.practitionerId);
    const { data, error } = await query.limit(1);
    if (error) return { state: "unreadable" };
    const row = (data as { id: string }[] | null)?.[0];
    return row ? { state: "found", appointmentId: row.id } : { state: "none" };
  } catch {
    return { state: "unreadable" };
  }
}

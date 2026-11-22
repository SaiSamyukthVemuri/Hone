import { emailBookingReference } from "@/lib/email/booking-reference";

// Appointment-reference lookup (HON-48 roadmap). The six-character reference in
// booking and cancellation email subjects is DERIVED from the appointment id
// (lib/email/booking-reference.ts): one-way, not stored, not a credential. So a
// lookup cannot ask the database for it; it recomputes the reference for the
// appointments the signed-in viewer may already read and keeps the ones that
// match. Nothing here grants access: the candidate ids come from a read scoped
// to the viewer's own studio, behind the row-level policies.

// The unambiguous alphabet and length of emailBookingReference. Pasting from an
// email brings surrounding whitespace, a leading "#" or a "Ref" label, and any
// letter case; none of that is part of the reference.
const REFERENCE_SHAPE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** The canonical reference a pasted string names, or null when it names none. */
export function normalizeAppointmentReference(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .replace(/^(?:ref(?:erence)?\b[\s:.#-]*|#)/i, "")
    .trim()
    .toUpperCase();
  return REFERENCE_SHAPE.test(cleaned) ? cleaned : null;
}

/**
 * Every id in `ids` whose reference equals `reference`. More than one is
 * possible (a six-character digest can collide); the caller lists them all and
 * never opens one on its own.
 */
export function appointmentIdsForReference(reference: string, ids: ReadonlyArray<string>): string[] {
  return ids.filter((id) => emailBookingReference(id) === reference);
}

// Ids read per page and the most ids one lookup scans. The scan runs only when
// the query is exactly a reference, never on ordinary text. A studio past the
// bound gets an honest "not fully searched" notice rather than a false "none".
export const REFERENCE_SCAN_PAGE = 1000;
export const REFERENCE_SCAN_CAP = 20000;

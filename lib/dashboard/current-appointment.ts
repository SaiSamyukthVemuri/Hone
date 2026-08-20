import type { AppointmentStatus } from "@/lib/types/database";

// Chloe production feedback: "dashboard should highlight current client".
//
// WHAT "CURRENT" MEANS, exactly one rule, in one place:
//
//     starts_at <= NOW < ends_at        (half-open, so a visit stops being
//                                        current the instant it ends and two
//                                        back-to-back visits never overlap)
//   AND status is not completed / cancelled / no_show
//
// The status exclusions matter as much as the clock does. A no-show whose
// booked interval contains the current minute is emphatically NOT the person in
// the room, and neither is an appointment already completed early; highlighting
// either would tell the practitioner to walk into an empty room.
//
// V1 SEMANTICS ARE DELIBERATE. `nowMs` is supplied by the caller, read ONCE per
// Dashboard render, so the highlight is a statement about when the page
// rendered / refetched. There is no timer, no interval and no polling in this
// version: a row does not silently change meaning under the practitioner while
// she is reading it, and a stale highlight costs nothing that a refresh does
// not fix.
//
// PURE. No clock, no query, no React. That is what makes the rule testable
// without a database and what keeps every row on one shared instant instead of
// each calling Date.now() for itself.

/**
 * Statuses that can never be "current" however the clock reads. Exported so a
 * test names the same list the predicate uses rather than restating it.
 */
export const NOT_CURRENT_STATUSES = [
  "completed",
  "cancelled",
  "no_show",
] as const satisfies ReadonlyArray<AppointmentStatus>;

export type CurrentAppointmentCandidate = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
};

export function isCurrentAppointment(
  appt: CurrentAppointmentCandidate,
  nowMs: number,
): boolean {
  if ((NOT_CURRENT_STATUSES as ReadonlyArray<AppointmentStatus>).includes(appt.status)) {
    return false;
  }
  const startMs = Date.parse(appt.starts_at);
  const endMs = Date.parse(appt.ends_at);
  // An unparseable or inverted interval is not a fact about the current
  // minute, so it asserts nothing rather than guessing.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  if (endMs <= startMs) return false;
  return startMs <= nowMs && nowMs < endMs;
}

/**
 * The ids that are current on `nowMs`. A SET, not a single id: two
 * practitioners genuinely can be with two clients at the same moment, and this
 * must not quietly impose a one-chair studio by picking a winner. Two "Current"
 * rows appear only when the schedule really does contain two overlapping
 * appointments.
 */
export function currentAppointmentIds(
  appts: ReadonlyArray<CurrentAppointmentCandidate>,
  nowMs: number,
): Set<string> {
  const out = new Set<string>();
  for (const a of appts) if (isCurrentAppointment(a, nowMs)) out.add(a.id);
  return out;
}

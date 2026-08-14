// APPOINTMENT BOUNDARY B4, the shared contract for the repair surfaces.
//
// WHY THIS FILE EXISTS AS A SEPARATE MODULE
// A `"use server"` module may export ONLY async functions: Next.js turns every
// export into a callable server action, so a plain `export const` there is a
// build error. The repair constants and types are needed by BOTH the server
// actions and the client components, so they live here, in an ordinary module
// with no directive, and both sides import from it.
//
// These values MIRROR migration 0173. They do not define it. The database is
// the authority and re-checks every one of them; these exist so the form can
// hint before spending a round-trip, and so the detail page can compute display
// state. `tests/app/calendar/appointment-repair-source.test.ts` pins each value
// against the SQL constant it mirrors, so the two cannot drift.

/** Terminal statuses `revert_appointment_outcome` accepts. */
export const REVERTIBLE_STATUSES = ["completed", "no_show", "cancelled"] as const;
export type RevertibleStatus = (typeof REVERTIBLE_STATUSES)[number];

/** Mirrors `c_min_reason` in 0173, measured AFTER the SQL-side btrim. */
export const MIN_REPAIR_REASON_LENGTH = 10;

/** Mirrors `c_max_notes` in 0173, measured AFTER the SQL-side btrim. */
export const MAX_APPOINTMENT_NOTES_LENGTH = 2000;

/** Mirrors the 72-hour repair window in 0173, for display gating only. */
export const REPAIR_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Maps a terminal status to the audit action that established it. Byte-identical
 * to the CASE inside `revert_appointment_outcome`. A drift here would make the
 * page compute the repair window from the wrong audit event, so the surface
 * would offer a repair the command then refuses.
 */
export const BASELINE_ACTION: Record<RevertibleStatus, string> = {
  completed: "marked_complete",
  no_show: "marked_no_show",
  cancelled: "cancelled",
};

export type RepairResult = { ok: true } | { ok: false; error: string };

export type AppointmentRepairState =
  | { repairable: true }
  | { repairable: false; reason: string };

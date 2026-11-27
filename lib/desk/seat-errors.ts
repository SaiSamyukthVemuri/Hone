// The two ways the database refuses a front-desk write that the app did not pre-empt (0390): raised (P0001) by the invitation and
// receptionist triggers and by add_studio_receptionist, whose uuid return cannot carry a status. The database is the authority; the
// app's own pre-check exists only to give a good message early, and a race still lands here.

export const FRONT_DESK_NOT_ENABLED = "front_desk_not_enabled";
export const FRONT_DESK_SEAT_LIMIT = "front_desk_seat_limit_reached";

export const FRONT_DESK_OFF_MESSAGE = "The front desk is not switched on for this studio.";
export const FRONT_DESK_FULL_MESSAGE =
  "There are no free front-desk seats. Remove a member or a pending invitation first, or contact Hone about more seats.";

/** A plain message for a seat refusal raised by the database, or null when the error is something else. */
export function seatRefusalMessage(error: { message?: string } | null | undefined): string | null {
  const m = error?.message ?? "";
  if (m.includes(FRONT_DESK_SEAT_LIMIT)) return FRONT_DESK_FULL_MESSAGE;
  if (m.includes(FRONT_DESK_NOT_ENABLED)) return FRONT_DESK_OFF_MESSAGE;
  return null;
}

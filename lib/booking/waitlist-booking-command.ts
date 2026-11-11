// 0313 — the redeem-and-book command is used only when this flag is on.
//
// OFF BY DEFAULT, and the off path is the previous redeem-first behaviour,
// unchanged. The command is a migration: turning this on before 0313 is applied
// would make every invitation booking fail, so enabling it is a release step
// that follows the apply, not a code change.
export function waitlistBookingCommandEnabled(): boolean {
  return process.env.WAITLIST_BOOKING_COMMAND === "1";
}

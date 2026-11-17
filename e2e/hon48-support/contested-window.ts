// PURE. The verdict for the contested window between a booking and a repeating break on the same practitioner and slot.
//
// Rule creation and its occurrence reservations are ONE atomic database call: create_recurring_break_rule_and_materialize inserts the
// rule and materializes its occurrences in one transaction, and an AFTER INSERT trigger mirrors each occurrence into the
// reservation table, where a collision rolls the whole call back. The live definitions are the chain 0031, 0137, 0138 and 0297 for
// the create and materialize functions, and 0134 and 0137 for the trigger. So a saved rule always has its occurrence reservation,
// a refused rule leaves none, and the window is held by exactly one of the booking and the break. Counting `bookings + rules` could
// not see a rule saved WITHOUT its reservation, which would let both commit; this verdict requires the reservation.
//
// STATED BOUND. The verdict judges the END STATE only. It does not prove that the two submits actually contended: if one command
// finished before the other started, the same end state is reached with no race at all. The spec fires both clicks in one
// Promise.all and waits six seconds, which makes contention likely but not certain, so a green run shows the invariant held, not
// that the lock order was exercised. Contention itself is proven at the database level (tests/db), not here.

export type ContestedWindowOutcome = {
  /** Appointments committed for the contending client at the contested slot. */
  bookings: number;
  /** Rules saved under the test's own label. */
  rules: number;
  /** Occurrence reservations of THAT rule on the contested day (not of any other rule). */
  occurrenceReservations: number;
  /** Pairs of reservations of the practitioner's resource that overlap each other. */
  overlappingReservations: number;
};

export function contestedWindowFailures(o: ContestedWindowOutcome): string[] {
  const failures: string[] = [];
  if (o.rules > 1) failures.push(`${o.rules} rules were saved for one submit`);
  if (o.occurrenceReservations !== o.rules) {
    failures.push(
      `a saved rule must hold exactly its occurrence reservation and a refused rule none: rules=${o.rules}, occurrence reservations=${o.occurrenceReservations}`,
    );
  }
  const holders = o.bookings + o.occurrenceReservations;
  if (holders !== 1) {
    failures.push(`exactly one of the booking and the break must hold the contested window, found ${holders} (bookings=${o.bookings}, break occurrences=${o.occurrenceReservations})`);
  }
  if (o.overlappingReservations !== 0) failures.push(`the window is held twice: ${o.overlappingReservations} overlapping reservation pair(s)`);
  return failures;
}

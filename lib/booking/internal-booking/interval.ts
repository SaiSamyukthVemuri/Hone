import { fold } from "./candidate";

// AN ACKNOWLEDGEMENT IS ABOUT AN INTERVAL, NOT ABOUT A SESSION.
//
// WHY THIS EXISTS
// ---------------
// The first foundation stored approvals as naked booleans:
//
//   outsideHoursConfirmed: boolean
//   bufferConfirmed: boolean
//
// A boolean answers "did somebody tick something?" It cannot answer "WHAT did
// they tick it for?", and that second question is the only one that matters,
// because the thing being authorised is a persistent database exception
// attributed to a named owner.
//
// So every event that changed the appointment had to remember which booleans to
// clear, and the review found three separate places where it did not:
//
//   * 18:00 acknowledged as out-of-hours, retyped to 22:00 -> still confirmable;
//   * a buffer conflict acknowledged at 60 minutes, dragged to 90 -> the
//     approval issued for the shorter interval authorised the longer one;
//   * with two distinct exceptions in play, one tick satisfied both.
//
// That is the same open-ended obligation -- "remember to clear the right fields
// at every mutation site" -- that the derived CANDIDATE identity was introduced
// to end one level up. Reproducing it one level down was the actual defect.
//
// THE RULE HERE
// -------------
// An approval is STAMPED with the exact interval it approved, and its validity
// is DERIVED by comparing that stamp against the interval currently on screen.
// Nothing has to remember to clear anything: change the time, the duration, the
// service, the date, the practitioner, the timezone, the capacity mode or the
// client, and the key stops matching by construction.
//
// A clear may still be performed for UX tidiness. Correctness must never depend
// on one having happened.

/** The exact appointment an acknowledgement was granted for. */
export type BookingIntervalIdentity = {
  // Everything that decides which calendar and which day this is.
  candidateKey: string;
  // The instant that will actually be submitted.
  startsAtIso: string;
  // The length that will actually be booked: a normalised custom override when
  // there is one, otherwise the server's authoritative service length. Not the
  // raw form field -- see `normalizeDurationOverride`.
  effectiveDurationMinutes: number;
};

/**
 * Derived by the same fold as the candidate identity, so a field added to
 * `BookingIntervalIdentity` joins every approval comparison automatically.
 */
export function intervalKey(id: BookingIntervalIdentity): string {
  return fold(id);
}

/** An acknowledgement, valid only while it still describes the live interval. */
export type IntervalApproval = { intervalKey: string };

/** True only when the approval was granted for the interval now on screen. */
export function approvalIsCurrent(
  approval: IntervalApproval | null,
  currentKey: string | null,
): boolean {
  return approval !== null && currentKey !== null && approval.intervalKey === currentKey;
}

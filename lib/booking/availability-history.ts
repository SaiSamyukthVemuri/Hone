// Pure client-side history for the public-booking "Next available" navigation
// (PR A). The stack holds the dates the visitor JUMPED AWAY FROM via "Next
// available", so they can step back to a prior suggested day. Dates are the
// studio-timezone "YYYY-MM-DD" strings the booking form already uses — this
// helper never parses or shifts them, so timezone correctness is unaffected.
// No DB, no server round-trip: stepping back just re-selects a prior date and
// the form's normal slot fetch re-validates that day.

// Record the day being left (called on a successful "Next available" jump).
export function pushAvailabilityHistory(
  history: string[],
  leavingDate: string,
): string[] {
  return [...history, leavingDate];
}

// Step back: returns the most recently-left day (or null if none) plus the
// remaining stack. Never mutates the input.
export function popAvailabilityHistory(history: string[]): {
  previous: string | null;
  rest: string[];
} {
  if (history.length === 0) return { previous: null, rest: history };
  return {
    previous: history[history.length - 1],
    rest: history.slice(0, -1),
  };
}

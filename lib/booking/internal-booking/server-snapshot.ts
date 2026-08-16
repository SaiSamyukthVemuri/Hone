import type { AvailabilityWindow } from "./availability";

// WHAT THE SERVER ACTUALLY USED, AT ONE READ.
//
// The browser may display service facts. It may not be the AUTHORITY for any
// fact that decides whether a persistent booking exception is valid -- the
// effective duration above all, which was previously taken from a React
// `services` prop that ages.
//
// A snapshot is not permanent truth. It records what the server used at that
// read, so drift can be DETECTED later rather than assumed away.
export type InternalBookingServerSnapshot = {
  // The availability question this snapshot answers.
  availabilityKey: string;
  // The interval the server derived from the LOCKED service row.
  serviceDurationMinutes: number;
  // The resolved window, or unknown when it could not be read.
  window: AvailabilityWindow;
  // Suggestions, already reconciled against `window` by the action.
  slots: { start: string; end: string; startLabel: string }[];
};

// The bounded facts a buffer refusal reports.
//
// It must name the exact INTERVAL the server refused, not merely the candidate.
// A refusal identified only by candidate floats: the practitioner retypes the
// time or drags the length, the appointment becomes a different one, and an
// approval granted for the interval the server actually objected to silently
// authorises an interval it never saw.
export type BufferConflictSnapshot = {
  candidateKey: string;
  // The instant the server refused.
  startsAtIso: string;
  // The length that refusal was computed for.
  effectiveDurationMinutes: number;
  // The authoritative service length the server read while refusing, echoed
  // back on retry as an optimistic-concurrency PRECONDITION. Distinct from the
  // effective length above, which may be a custom override.
  serviceDurationMinutes: number;
};

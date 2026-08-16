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

// The bounded facts a buffer refusal reports, so a retry can state the exact
// interval it is acting on. Deliberately narrow: a duration and the candidate
// it belongs to, nothing else about the service or the studio.
export type BufferConflictSnapshot = {
  candidateKey: string;
  serviceDurationMinutes: number;
};

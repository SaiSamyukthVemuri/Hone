import {
  availabilityKey,
  candidateKey,
  isAvailabilityAskable,
  type InternalBookingCandidateIdentity,
} from "./candidate";
import type {
  BufferConflictSnapshot,
  InternalBookingServerSnapshot,
} from "./server-snapshot";

// THE ONE TRANSITION LAW.
//
// Previously each surface carried a collection of effects and handlers, and
// correctness depended on every one of them remembering which OTHER pieces of
// state to clear. That is what produced four consecutive rounds of neighbouring
// defects: a date change cleared four things and forgot the fifth; a capacity
// change invalidated without replacing; a refetch installed slots without the
// window.
//
// Here, an identity change is ONE transition and it revokes everything the old
// identity justified, intrinsically. No caller performs a sequence of clears.

export type InternalBookingState = {
  identity: InternalBookingCandidateIdentity;
  // The last successfully committed snapshot, and the availability question it
  // answers. Kept even when no longer current so a surface may show something
  // while refreshing -- but `snapshotIsCurrent` is what gates authority.
  snapshot: InternalBookingServerSnapshot | null;
  // An in-flight availability request, by the key it will answer for.
  loadingKey: string | null;
  // The last request for the CURRENT key failed. Display may persist; authority
  // may not.
  loadFailed: boolean;
  // Chosen suggestion, as the instant it was offered for.
  pickedSlotStart: string | null;
  // Typed studio-local "HH:MM".
  manualTime: string;
  manualEnabled: boolean;
  // A server buffer refusal, scoped to the candidate it was issued for.
  bufferOffer: BufferConflictSnapshot | null;
  bufferConfirmed: boolean;
  outsideHoursConfirmed: boolean;
};

export type InternalBookingEvent =
  | { type: "OPEN"; identity: InternalBookingCandidateIdentity }
  | { type: "CLOSE" }
  | { type: "SERVICE_CHANGED"; serviceId: string | null }
  | { type: "DATE_CHANGED"; date: string | null }
  | { type: "TARGET_CHANGED"; targetPractitionerId: string | null }
  | { type: "CAPACITY_MODE_CHANGED"; capacityMode: boolean }
  | { type: "TIMEZONE_CHANGED"; timezone: string }
  | { type: "CLIENT_CHANGED"; clientId: string | null }
  | { type: "SLOT_REQUEST_STARTED"; key: string }
  | {
      type: "SLOT_REQUEST_SUCCEEDED";
      snapshot: InternalBookingServerSnapshot;
    }
  | { type: "SLOT_REQUEST_FAILED"; key: string }
  | { type: "SUGGESTION_SELECTED"; startsAtIso: string | null }
  | { type: "MANUAL_TIME_ENABLED"; enabled: boolean }
  | { type: "MANUAL_TIME_CHANGED"; localTime: string }
  | { type: "BUFFER_CONFLICT_RETURNED"; conflict: BufferConflictSnapshot }
  | { type: "BUFFER_ACKNOWLEDGED"; acknowledged: boolean }
  | { type: "OUTSIDE_HOURS_ACKNOWLEDGED"; acknowledged: boolean }
  | { type: "BOOKING_SUCCEEDED" };

export function initialState(
  identity: InternalBookingCandidateIdentity,
): InternalBookingState {
  return {
    identity,
    snapshot: null,
    loadingKey: null,
    loadFailed: false,
    pickedSlotStart: null,
    manualTime: "",
    manualEnabled: false,
    bufferOffer: null,
    bufferConfirmed: false,
    outsideHoursConfirmed: false,
  };
}

// THE SINGLE REVOCATION. Applied by every identity transition, so no caller can
// change one dimension and forget what that invalidates.
//
// It deliberately does NOT drop `snapshot`: a surface may keep showing the last
// result while the replacement loads. What it drops is everything that could
// AUTHORISE something -- the selection, both acknowledgements and the buffer
// offer -- and the derived `snapshotIsCurrent` then reports the snapshot as
// non-authoritative because its key no longer matches.
function withIdentity(
  state: InternalBookingState,
  identity: InternalBookingCandidateIdentity,
): InternalBookingState {
  if (candidateKey(state.identity) === candidateKey(identity)) return state;
  return {
    ...state,
    identity,
    // A request in flight for the old question may no longer commit.
    loadingKey: null,
    loadFailed: false,
    pickedSlotStart: null,
    bufferOffer: null,
    bufferConfirmed: false,
    outsideHoursConfirmed: false,
  };
}

export function reduce(
  state: InternalBookingState,
  event: InternalBookingEvent,
): InternalBookingState {
  switch (event.type) {
    case "OPEN":
      return initialState(event.identity);
    case "CLOSE":
      return initialState(state.identity);

    case "SERVICE_CHANGED":
      return withIdentity(state, { ...state.identity, serviceId: event.serviceId });
    case "DATE_CHANGED":
      return withIdentity(state, { ...state.identity, date: event.date });
    case "TARGET_CHANGED":
      return withIdentity(state, {
        ...state.identity,
        targetPractitionerId: event.targetPractitionerId,
      });
    case "CAPACITY_MODE_CHANGED":
      return withIdentity(state, {
        ...state.identity,
        capacityMode: event.capacityMode,
      });
    case "TIMEZONE_CHANGED":
      return withIdentity(state, { ...state.identity, timezone: event.timezone });
    case "CLIENT_CHANGED":
      return withIdentity(state, { ...state.identity, clientId: event.clientId });

    case "SLOT_REQUEST_STARTED":
      // Only the current question may be in flight.
      if (event.key !== availabilityKey(state.identity)) return state;
      return { ...state, loadingKey: event.key, loadFailed: false };

    case "SLOT_REQUEST_SUCCEEDED": {
      // ATOMIC, and only for the current question. Slots, window and the
      // authoritative duration install together or not at all -- there is no
      // path that sets one without the others.
      if (event.snapshot.availabilityKey !== availabilityKey(state.identity)) {
        return state;
      }
      return {
        ...state,
        snapshot: event.snapshot,
        loadingKey: null,
        loadFailed: false,
      };
    }

    case "SLOT_REQUEST_FAILED":
      if (event.key !== availabilityKey(state.identity)) return state;
      // Old data may remain for display; authority is withdrawn by
      // `snapshotIsCurrent` being false while the key does not match, and by
      // this flag when it does.
      return { ...state, loadingKey: null, loadFailed: true };

    case "SUGGESTION_SELECTED":
      // Choosing a different appointment revokes an approval issued for another.
      return {
        ...state,
        pickedSlotStart: event.startsAtIso,
        bufferOffer: null,
        bufferConfirmed: false,
      };

    case "MANUAL_TIME_ENABLED":
      return {
        ...state,
        manualEnabled: event.enabled,
        outsideHoursConfirmed: false,
        bufferOffer: null,
        bufferConfirmed: false,
      };

    case "MANUAL_TIME_CHANGED":
      return {
        ...state,
        manualTime: event.localTime,
        bufferOffer: null,
        bufferConfirmed: false,
      };

    case "BUFFER_CONFLICT_RETURNED":
      // Honoured only if it describes the candidate on screen.
      if (event.conflict.candidateKey !== candidateKey(state.identity)) {
        return state;
      }
      return { ...state, bufferOffer: event.conflict, bufferConfirmed: false };

    case "BUFFER_ACKNOWLEDGED":
      if (!state.bufferOffer) return state;
      return { ...state, bufferConfirmed: event.acknowledged };

    case "OUTSIDE_HOURS_ACKNOWLEDGED":
      return { ...state, outsideHoursConfirmed: event.acknowledged };

    case "BOOKING_SUCCEEDED":
      return initialState(state.identity);

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// DERIVED FACTS. Recovery is derived, never remembered: any identity change
// makes `needsLoad` true, so a surface that runs one effect on it recovers from
// EVERY dimension -- including ones added later. That is the property the
// hand-written two-prop effect lacked.
// ---------------------------------------------------------------------------

export function currentAvailabilityKey(state: InternalBookingState): string {
  return availabilityKey(state.identity);
}

export function snapshotIsCurrent(state: InternalBookingState): boolean {
  return (
    state.snapshot !== null &&
    state.snapshot.availabilityKey === currentAvailabilityKey(state) &&
    !state.loadFailed
  );
}

export function needsLoad(state: InternalBookingState): boolean {
  if (!isAvailabilityAskable(state.identity)) return false;
  const key = currentAvailabilityKey(state);
  if (state.loadingKey === key) return false;
  if (state.loadFailed) return false; // do not hot-loop a failing request
  return state.snapshot?.availabilityKey !== key;
}

/** The buffer approval applies only while its candidate is still on screen. */
export function bufferOfferIsCurrent(state: InternalBookingState): boolean {
  return (
    state.bufferOffer !== null &&
    state.bufferOffer.candidateKey === candidateKey(state.identity)
  );
}

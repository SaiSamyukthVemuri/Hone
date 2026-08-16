import {
  decideManualTime,
  normalizeDurationOverride,
  type ManualTimeDecision,
} from "./availability";
import {
  availabilityKey,
  candidateKey,
  isAvailabilityAskable,
  type InternalBookingCandidateIdentity,
} from "./candidate";
import {
  approvalIsCurrent,
  intervalKey,
  type IntervalApproval,
} from "./interval";
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
//
// TWO DERIVED IDENTITIES DO THE WORK
// ----------------------------------
//   REQUEST TOKEN    availability question + retry epoch. Decides which
//                    in-flight answer may commit, and -- because it does NOT
//                    change when a request merely records that it started --
//                    it can safely key the effect that issues the request.
//   INTERVAL KEY     candidate + start instant + effective duration. Decides
//                    which acknowledgements are still about the appointment on
//                    screen. Nothing has to remember to revoke them.

export type OutsideApproval = IntervalApproval & {
  // Recorded so the approval can say WHAT was acknowledged, not merely that
  // something was. `custom_duration` and `outside_availability` are different
  // claims about the practitioner's schedule.
  reason: NonNullable<ManualTimeDecision["overrideReason"]>;
};

export type InternalBookingState = {
  identity: InternalBookingCandidateIdentity;
  // The last successfully committed snapshot, and the availability question it
  // answers. Kept even when no longer current so a surface may show something
  // while refreshing -- but `snapshotIsCurrent` is what gates authority.
  snapshot: InternalBookingServerSnapshot | null;
  // Monotonic. Bumped by an explicit retry and by every reset that discards the
  // snapshot, so a replacement request is requested by the token CHANGING
  // rather than by anyone remembering to ask for one.
  requestEpoch: number;
  // The request token currently in flight, or null.
  loadingToken: string | null;
  // The token of the last request that SETTLED, either way. Together with
  // `loadingToken` this makes "has the current question been asked yet?" a
  // single fact, so `needsLoad` and the effect that issues requests cannot
  // answer it differently -- they did, for the retry case, until this existed.
  settledToken: string | null;
  // That settlement was a failure. Display may persist; authority may not.
  loadFailed: boolean;
  // Chosen suggestion, as the instant it was offered for.
  pickedSlotStart: string | null;
  // Typed studio-local "HH:MM".
  manualTime: string;
  manualEnabled: boolean;
  // The RAW user-selected length. Never used directly: normalisation against
  // the server's authoritative service length is derived below, so a value
  // equal to the default is an ordinary booking rather than an override.
  customDurationMinutes: number | null;
  // A server buffer refusal, scoped to the interval it was issued for.
  bufferOffer: BufferConflictSnapshot | null;
  // Interval-stamped acknowledgements. See ./interval.ts for why these are not
  // booleans.
  bufferApproval: IntervalApproval | null;
  outsideApproval: OutsideApproval | null;
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
  | { type: "SLOT_REQUEST_STARTED"; token: string }
  | {
      type: "SLOT_REQUEST_SUCCEEDED";
      token: string;
      snapshot: InternalBookingServerSnapshot;
    }
  | { type: "SLOT_REQUEST_FAILED"; token: string }
  // The ONLY way a failed load is retried. Deliberately explicit: an automatic
  // clear would hot-loop, and no clear at all left the controller permanently
  // non-authoritative.
  | { type: "RETRY_REQUESTED" }
  | { type: "SUGGESTION_SELECTED"; startsAtIso: string | null }
  | { type: "MANUAL_TIME_ENABLED"; enabled: boolean }
  | { type: "MANUAL_TIME_CHANGED"; localTime: string }
  | { type: "CUSTOM_DURATION_CHANGED"; minutes: number | null }
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
    requestEpoch: 0,
    loadingToken: null,
    settledToken: null,
    loadFailed: false,
    pickedSlotStart: null,
    manualTime: "",
    manualEnabled: false,
    customDurationMinutes: null,
    bufferOffer: null,
    bufferApproval: null,
    outsideApproval: null,
  };
}

// A reset that DISCARDS the snapshot must also move the epoch, or the request
// token would be byte-identical to the one already answered and no replacement
// would ever be issued.
function resetTo(
  state: InternalBookingState,
  identity: InternalBookingCandidateIdentity,
): InternalBookingState {
  return {
    ...initialState(identity),
    requestEpoch: state.requestEpoch + 1,
  };
}

// THE SINGLE REVOCATION for an identity change.
//
// It deliberately does NOT drop `snapshot`: a surface may keep showing the last
// result while the replacement loads, and `snapshotIsCurrent` reports it
// non-authoritative because its key no longer matches.
//
// It also deliberately does NOT clear the approvals. Their validity is derived
// from the interval key, which contains the candidate key, so an identity
// change invalidates them by construction. Clearing here would work today and
// would hide the fact that correctness no longer depends on remembering to.
function withIdentity(
  state: InternalBookingState,
  identity: InternalBookingCandidateIdentity,
): InternalBookingState {
  if (candidateKey(state.identity) === candidateKey(identity)) return state;
  return {
    ...state,
    identity,
    // A request in flight for the old question may no longer commit.
    loadingToken: null,
    loadFailed: false,
    pickedSlotStart: null,
  };
}

export function reduce(
  state: InternalBookingState,
  event: InternalBookingEvent,
): InternalBookingState {
  switch (event.type) {
    case "OPEN":
      return resetTo(state, event.identity);
    case "CLOSE":
      return resetTo(state, state.identity);

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
      // Only the current question, at the current epoch, may be in flight.
      if (event.token !== currentRequestToken(state)) return state;
      // NOTE what this does NOT do: it records the request without changing
      // the request token. The token is what the issuing effect is keyed to,
      // so recording a start cannot cancel the very request it recorded.
      return { ...state, loadingToken: event.token, loadFailed: false };

    case "SLOT_REQUEST_SUCCEEDED": {
      // ATOMIC, and only for the current token. Slots, window and the
      // authoritative duration install together or not at all -- there is no
      // path that sets one without the others.
      //
      // This is the load-bearing guard. The effect's cancellation is a
      // courtesy: a result whose token has moved on is refused here even if
      // nothing cancelled it.
      if (event.token !== currentRequestToken(state)) return state;
      return {
        ...state,
        snapshot: event.snapshot,
        loadingToken: null,
        settledToken: event.token,
        loadFailed: false,
      };
    }

    case "SLOT_REQUEST_FAILED":
      if (event.token !== currentRequestToken(state)) return state;
      // Old data may remain for display; authority is withdrawn by
      // `snapshotIsCurrent`.
      return {
        ...state,
        loadingToken: null,
        settledToken: event.token,
        loadFailed: true,
      };

    case "RETRY_REQUESTED": {
      // Moves the epoch, which moves the token, which is what causes exactly
      // one replacement request. The identity is untouched.
      if (!isAvailabilityAskable(state.identity)) return state;
      return {
        ...state,
        requestEpoch: state.requestEpoch + 1,
        loadingToken: null,
        loadFailed: false,
      };
    }

    case "SUGGESTION_SELECTED":
      if (state.pickedSlotStart === event.startsAtIso) return state;
      // No approval is cleared here. Choosing another appointment changes the
      // start instant, so the interval key changes and every approval stamped
      // to the previous one stops matching.
      return { ...state, pickedSlotStart: event.startsAtIso };

    case "MANUAL_TIME_ENABLED":
      if (state.manualEnabled === event.enabled) return state;
      return { ...state, manualEnabled: event.enabled };

    case "MANUAL_TIME_CHANGED":
      if (state.manualTime === event.localTime) return state;
      return { ...state, manualTime: event.localTime };

    case "CUSTOM_DURATION_CHANGED":
      if (state.customDurationMinutes === event.minutes) return state;
      return { ...state, customDurationMinutes: event.minutes };

    case "BUFFER_CONFLICT_RETURNED":
      // Honoured only if it describes the interval on screen -- not merely the
      // candidate. A refusal for a start or a length that has since changed is
      // about a different appointment.
      if (bufferOfferIntervalKey(event.conflict) !== currentIntervalKey(state)) {
        return state;
      }
      return { ...state, bufferOffer: event.conflict, bufferApproval: null };

    case "BUFFER_ACKNOWLEDGED": {
      if (!bufferOfferIsCurrent(state)) return state;
      const key = currentIntervalKey(state);
      if (key === null) return state;
      // Stamped with the interval, by the reducer rather than by the caller:
      // a surface cannot acknowledge one appointment and post another.
      return {
        ...state,
        bufferApproval: event.acknowledged ? { intervalKey: key } : null,
      };
    }

    case "OUTSIDE_HOURS_ACKNOWLEDGED": {
      const key = currentIntervalKey(state);
      const reason = manualDecision(state).overrideReason;
      // There is nothing to acknowledge without a live interval and a truthful
      // reason -- an unreadable window in particular must never be
      // acknowledgeable, because that persists an exception that was not a fact.
      if (!event.acknowledged || key === null || reason === null) {
        return state.outsideApproval === null
          ? state
          : { ...state, outsideApproval: null };
      }
      return { ...state, outsideApproval: { intervalKey: key, reason } };
    }

    case "BOOKING_SUCCEEDED":
      return resetTo(state, state.identity);

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// DERIVED FACTS. Recovery and revocation are both DERIVED, never remembered:
// any identity change moves the request token, and any change to the
// appointment moves the interval key. A dimension added to either identity type
// is therefore covered without editing a single transition.
// ---------------------------------------------------------------------------

export function currentAvailabilityKey(state: InternalBookingState): string {
  return availabilityKey(state.identity);
}

/**
 * The question currently being asked, at the current retry epoch. Null when the
 * candidate is too incomplete to ask anything.
 *
 * This is what the request effect is keyed to. It changes when the identity
 * changes or a retry is requested, and at no other time -- crucially NOT when a
 * request records that it started, which is what made the previous effect
 * cancel its own in-flight load.
 */
export function currentRequestToken(state: InternalBookingState): string | null {
  if (!isAvailabilityAskable(state.identity)) return null;
  return `${currentAvailabilityKey(state)}@${state.requestEpoch}`;
}

export function snapshotIsCurrent(state: InternalBookingState): boolean {
  return (
    state.snapshot !== null &&
    state.snapshot.availabilityKey === currentAvailabilityKey(state) &&
    !state.loadFailed
  );
}

/** True while a request for the CURRENT token is outstanding. */
export function isLoading(state: InternalBookingState): boolean {
  return state.loadingToken !== null && state.loadingToken === currentRequestToken(state);
}

/**
 * The current request token has neither been asked nor answered.
 *
 * This is EXACTLY the condition the request effect acts on, which is why it is
 * expressed once. A settled token -- succeeded or failed -- is not re-requested,
 * so a failure cannot hot-loop; only a new identity or an explicit retry moves
 * the token and asks again.
 */
export function needsLoad(state: InternalBookingState): boolean {
  const token = currentRequestToken(state);
  if (token === null) return false;
  return state.loadingToken !== token && state.settledToken !== token;
}

/** The server's authoritative service length, or null when none is current. */
export function authoritativeServiceDuration(
  state: InternalBookingState,
): number | null {
  return snapshotIsCurrent(state) ? (state.snapshot?.serviceDurationMinutes ?? null) : null;
}

/**
 * THE ONE NORMALISATION. A raw length equal to the authoritative default is not
 * an override; it is an ordinary booking that happens to have the field filled
 * in. Derived here so display, classification, the interval key and the
 * submission plan cannot disagree about it.
 */
export function normalizedDurationOverride(
  state: InternalBookingState,
): number | null {
  return normalizeDurationOverride(
    state.customDurationMinutes,
    authoritativeServiceDuration(state),
  );
}

/** What will actually be booked: the override when there is one, else the default. */
export function effectiveDurationMinutes(
  state: InternalBookingState,
): number | null {
  return normalizedDurationOverride(state) ?? authoritativeServiceDuration(state);
}

/** The manual-path verdict, measured against the SERVER's facts. */
export function manualDecision(state: InternalBookingState): ManualTimeDecision {
  // A snapshot that is not current is handed over as a NULL window, which the
  // shared decision already reads as "not loaded": manual path blocked,
  // truthful checking copy, no acknowledgement, no flag. Loading and staleness
  // never present themselves as "outside hours".
  const snapshot = snapshotIsCurrent(state) ? state.snapshot : null;
  return decideManualTime({
    window: snapshot?.window ?? null,
    localDate: state.identity.date ?? "",
    localTime: state.manualTime,
    timezone: state.identity.timezone,
    serviceDurationMinutes: snapshot?.serviceDurationMinutes ?? null,
    customDurationMinutes: state.customDurationMinutes,
  });
}

/** The instant that would be submitted right now, whichever path is active. */
export function currentStartsAtIso(state: InternalBookingState): string | null {
  return state.manualEnabled
    ? manualDecision(state).startsAtIso
    : state.pickedSlotStart;
}

/**
 * The appointment currently on screen, as an identity. Null when there is not
 * yet a complete one -- and a null key matches nothing, so no approval issued
 * for a real interval can survive into an incomplete one.
 */
export function currentIntervalKey(state: InternalBookingState): string | null {
  const startsAtIso = currentStartsAtIso(state);
  const effectiveDuration = effectiveDurationMinutes(state);
  if (startsAtIso === null || effectiveDuration === null) return null;
  return intervalKey({
    candidateKey: candidateKey(state.identity),
    startsAtIso,
    effectiveDurationMinutes: effectiveDuration,
  });
}

/** The interval a buffer refusal was issued for, as the same kind of key. */
export function bufferOfferIntervalKey(offer: BufferConflictSnapshot): string {
  return intervalKey({
    candidateKey: offer.candidateKey,
    startsAtIso: offer.startsAtIso,
    effectiveDurationMinutes: offer.effectiveDurationMinutes,
  });
}

/** A buffer refusal applies only while it describes the live interval. */
export function bufferOfferIsCurrent(state: InternalBookingState): boolean {
  return (
    state.bufferOffer !== null &&
    bufferOfferIntervalKey(state.bufferOffer) === currentIntervalKey(state)
  );
}

export function bufferApprovalIsCurrent(state: InternalBookingState): boolean {
  return (
    bufferOfferIsCurrent(state) &&
    approvalIsCurrent(state.bufferApproval, currentIntervalKey(state))
  );
}

export function outsideApprovalIsCurrent(state: InternalBookingState): boolean {
  return approvalIsCurrent(state.outsideApproval, currentIntervalKey(state));
}

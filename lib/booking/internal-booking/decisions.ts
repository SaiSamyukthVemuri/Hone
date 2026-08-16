import { selectedSlotMatchesDate, type ManualTimeDecision } from "./availability";
import { candidateKey } from "./candidate";
import {
  bufferApprovalIsCurrent,
  bufferOfferIsCurrent,
  currentIntervalKey,
  currentStartsAtIso,
  manualDecision,
  normalizedDurationOverride,
  outsideApprovalIsCurrent,
  snapshotIsCurrent,
  type InternalBookingState,
} from "./reducer";

// THE ONE CONFIRMABILITY LAW, and the one submission payload.
//
// Both surfaces asked these questions for themselves, and drifted: one gated
// the outside-hours acknowledgement on ownership and the other did not; one
// bound a suggestion to the form date and the other did not; one rebuilt the
// buffer key from the server's duration and the other did not. Asking once is
// the point of this module.

export type SubmissionPlan = {
  startsAtIso: string | null;
  // Posted only for a reason the server accepts it for, and only ever after
  // every applicable acknowledgement.
  allowOutsideAvailability: boolean;
  // The interval a buffer refusal was issued for, echoed back as an
  // optimistic-concurrency PRECONDITION. The server re-reads the service row
  // and refuses on drift; this can only cause a refusal, never an acceptance.
  expectedDurationMinutes: number | null;
  // A genuinely custom length, when one applies. NORMALISED: a value equal to
  // the authoritative service default is not an override, and posting it as one
  // would have the command and the audit record classify an ordinary
  // appointment as a duration exception.
  durationOverrideMinutes: number | null;
};

export type InternalBookingDecision = {
  /** The snapshot may be shown, but may not authorise anything. */
  snapshotStale: boolean;
  manual: ManualTimeDecision;
  /** True when a suggestion is selected AND still belongs to this candidate. */
  suggestionUsable: boolean;
  bufferOffered: boolean;
  /** An out-of-hours or custom-duration exception applies to this interval. */
  outsideExceptionRequired: boolean;
  /** ...and has been acknowledged FOR this interval. */
  outsideExceptionSatisfied: boolean;
  /** A buffer exception applies to this interval. */
  bufferExceptionRequired: boolean;
  /** ...and has been acknowledged FOR this interval. */
  bufferExceptionSatisfied: boolean;
  canConfirm: boolean;
  plan: SubmissionPlan;
};

export function decide(input: {
  state: InternalBookingState;
  isOwner: boolean;
}): InternalBookingDecision {
  const { state, isOwner } = input;
  const current = snapshotIsCurrent(state);
  const manual = manualDecision(state);

  const suggestionUsable =
    current &&
    selectedSlotMatchesDate({
      startsAtIso: state.pickedSlotStart,
      formDate: state.identity.date ?? "",
      timezone: state.identity.timezone,
    });

  // TWO EXCEPTIONS ARE TWO FACTS.
  //
  // An out-of-hours (or custom-length) booking and a soft-buffer overlap are
  // different assertions about different things, and both are persisted. The
  // first foundation asked a single "was something acknowledged?" question, so
  // when both applied, ticking the buffer box alone authorised the out-of-hours
  // exception nobody had agreed to. Each required exception now has to be
  // satisfied on its own terms, for THIS interval.
  const outsideExceptionRequired = state.manualEnabled && manual.requiresOutsideOverride;
  const bufferExceptionRequired = bufferOfferIsCurrent(state);
  const outsideExceptionSatisfied =
    !outsideExceptionRequired || outsideApprovalIsCurrent(state);
  const bufferExceptionSatisfied =
    !bufferExceptionRequired || bufferApprovalIsCurrent(state);

  const needsException = outsideExceptionRequired || bufferExceptionRequired;
  const allExceptionsSatisfied = outsideExceptionSatisfied && bufferExceptionSatisfied;

  const baseUsable = state.manualEnabled
    ? manual.windowKnown && manual.timeValid
    : suggestionUsable;

  // OWNER-ONLY AUTHORITY, HARMONISED. Anything requiring the persistent
  // exception is owner-only in the server action and again in the DB command.
  // One surface enforced that client-side and the other did not, so a member
  // was handed an actionable acknowledgement that the server then refused. The
  // copy stays truthful; the control simply is not actionable.
  const canConfirm =
    Boolean(state.identity.clientId) &&
    Boolean(state.identity.serviceId) &&
    Boolean(state.identity.targetPractitionerId) &&
    current &&
    baseUsable &&
    // A live interval must exist before anything about it can be authorised.
    (!needsException || currentIntervalKey(state) !== null) &&
    (!needsException || (isOwner && allExceptionsSatisfied));

  const allowOutsideAvailability = needsException && isOwner && allExceptionsSatisfied;

  return {
    snapshotStale: !current,
    manual,
    suggestionUsable,
    bufferOffered: bufferExceptionRequired,
    outsideExceptionRequired,
    outsideExceptionSatisfied,
    bufferExceptionRequired,
    bufferExceptionSatisfied,
    canConfirm,
    plan: {
      startsAtIso: currentStartsAtIso(state),
      allowOutsideAvailability,
      // Only meaningful alongside the flag, and only from the server's refusal.
      expectedDurationMinutes:
        allowOutsideAvailability && bufferExceptionRequired
          ? (state.bufferOffer?.serviceDurationMinutes ?? null)
          : null,
      // THE NORMALISED value -- the same one that decided whether an exception
      // was required at all and the same one stamped into the interval key.
      durationOverrideMinutes: allowOutsideAvailability
        ? normalizedDurationOverride(state)
        : null,
    },
  };
}

/** The candidate identity string a buffer refusal must be scoped to. */
export function currentCandidateKey(state: InternalBookingState): string {
  return candidateKey(state.identity);
}

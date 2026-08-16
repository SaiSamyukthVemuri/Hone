import {
  decideManualTime,
  selectedSlotMatchesDate,
  type ManualTimeDecision,
} from "../availability-window";
import { candidateKey } from "./candidate";
import {
  bufferOfferIsCurrent,
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
  // Posted only for a reason the server accepts it for, and only ever after an
  // explicit acknowledgement.
  allowOutsideAvailability: boolean;
  // The interval a buffer refusal was issued for, echoed back as an
  // optimistic-concurrency PRECONDITION. The server re-reads the service row
  // and refuses on drift; this can only cause a refusal, never an acceptance.
  expectedDurationMinutes: number | null;
  // A genuinely custom length, when one applies.
  durationOverrideMinutes: number | null;
};

export type InternalBookingDecision = {
  /** The snapshot may be shown, but may not authorise anything. */
  snapshotStale: boolean;
  manual: ManualTimeDecision;
  /** True when a suggestion is selected AND still belongs to this candidate. */
  suggestionUsable: boolean;
  bufferOffered: boolean;
  canConfirm: boolean;
  plan: SubmissionPlan;
};

export function decide(input: {
  state: InternalBookingState;
  isOwner: boolean;
  /** A drag-derived length, already parsed; null when there is none. */
  customDurationMinutes: number | null;
  /** Converts studio-local date + "HH:MM" into the instant that will be sent. */
  toInstantIso: (date: string, localTime: string) => string | null;
}): InternalBookingDecision {
  const { state, isOwner } = input;
  const current = snapshotIsCurrent(state);
  const snapshot = current ? state.snapshot : null;

  // A snapshot that is not current is handed over as a NULL window, which the
  // shared decision already reads as "not loaded": manual path blocked,
  // truthful checking copy, no acknowledgement, no flag. Loading and staleness
  // never present themselves as "outside hours".
  const manual = decideManualTime({
    window: snapshot?.window ?? null,
    localDate: state.identity.date ?? "",
    localTime: state.manualTime,
    timezone: state.identity.timezone,
    // The AUTHORITATIVE length the server used, never a client-held prop.
    serviceDurationMinutes: snapshot?.serviceDurationMinutes ?? null,
    customDurationMinutes: input.customDurationMinutes,
  });

  const suggestionUsable =
    current &&
    selectedSlotMatchesDate({
      startsAtIso: state.pickedSlotStart,
      formDate: state.identity.date ?? "",
      timezone: state.identity.timezone,
    });

  const bufferOffered = bufferOfferIsCurrent(state);

  // OWNER-ONLY AUTHORITY, HARMONISED. Anything requiring the persistent
  // exception is owner-only in the server action and again in the DB command.
  // One surface enforced that client-side and the other did not, so a member
  // was handed an actionable acknowledgement that the server then refused. The
  // copy stays truthful; the control simply is not actionable.
  const needsException =
    (state.manualEnabled && manual.requiresOutsideOverride) || bufferOffered;
  const exceptionAcknowledged = state.manualEnabled
    ? bufferOffered
      ? state.bufferConfirmed
      : manual.requiresOutsideOverride
        ? state.outsideHoursConfirmed
        : true
    : bufferOffered
      ? state.bufferConfirmed
      : true;

  const baseUsable = state.manualEnabled
    ? manual.windowKnown && manual.timeValid
    : suggestionUsable;

  const canConfirm =
    Boolean(state.identity.clientId) &&
    Boolean(state.identity.serviceId) &&
    Boolean(state.identity.targetPractitionerId) &&
    current &&
    baseUsable &&
    (!needsException || (isOwner && exceptionAcknowledged));

  const startsAtIso = state.manualEnabled
    ? manual.timeValid && state.identity.date
      ? input.toInstantIso(state.identity.date, state.manualTime)
      : null
    : state.pickedSlotStart;

  const allowOutsideAvailability =
    needsException && isOwner && exceptionAcknowledged;

  return {
    snapshotStale: !current,
    manual,
    suggestionUsable,
    bufferOffered,
    canConfirm,
    plan: {
      startsAtIso,
      allowOutsideAvailability,
      // Only meaningful alongside the flag, and only from the server's refusal.
      expectedDurationMinutes:
        allowOutsideAvailability && bufferOffered
          ? (state.bufferOffer?.serviceDurationMinutes ?? null)
          : null,
      durationOverrideMinutes:
        allowOutsideAvailability && input.customDurationMinutes != null
          ? input.customDurationMinutes
          : null,
    },
  };
}

/** The candidate identity string a buffer refusal must be scoped to. */
export function currentCandidateKey(state: InternalBookingState): string {
  return candidateKey(state.identity);
}

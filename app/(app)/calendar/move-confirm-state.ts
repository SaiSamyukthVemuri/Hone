// The ONE confirm gate for the practitioner Move appointment dialog.
//
// Whether the primary action is enabled AND the sentence shown next to it are
// derived HERE, from the same inputs, in one pass. Before EMERG-02 the gate was
// an inline boolean in the dialog and there was no sentence at all, so a greyed
// "Move appointment" concealed its own prerequisite. Keeping both answers in one
// function is what stops the copy and the button state from drifting apart.
//
// AUTHORITY NOTE — this MIRRORS the database, it does not invent policy.
// `move_or_reassign_appointment` coalesces a NULL target to the appointment's
// current practitioner and then validates that practitioner independently: on a
// capacity-ON studio an inactive or non-service-eligible holder returns
// `practitioner_reassignment_required` (migration 0144, carried into 0174;
// proved by tests/db/move-target-integrity.db.test.ts). So "reassignment
// required" is a REAL server precondition and it blocks a custom-time override
// exactly as it blocks a generated-slot move. Relaxing it here would only move
// the refusal from a disabled button to a failed mutation.
//
// The no-change rule is likewise the server's: the command returns `no_change`
// when neither the instant nor the practitioner differs. The dialog refuses to
// submit a move that proposes nothing rather than spending a round trip to be
// told so.

export type MoveMode = "available_slot" | "custom_time";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export type MoveConfirmInput = {
  mode: MoveMode;
  /** A mutation is in flight; the button carries its own "Moving…" label. */
  submitting: boolean;
  // ---- reassignment context, all server-authoritative -----------------------
  /** Owner of a capacity-ON studio. Members + Legacy studios never reassign. */
  reassignEnabled: boolean;
  eligibleIds: readonly string[];
  /** "" = nothing chosen. */
  target: string;
  /** "" when the appointment holds no practitioner (practitioner_id is nullable). */
  currentPractitionerId: string;
  // ---- available-slot mode --------------------------------------------------
  hasSlot: boolean;
  loadingSlots: boolean;
  // ---- custom-time mode -----------------------------------------------------
  date: string;
  customTime: string;
  ackOverride: boolean;
  // ---- change detection (the server's no_change contract) -------------------
  timeChanged: boolean;
};

export type MoveConfirmState = {
  canConfirm: boolean;
  /**
   * Why the primary action is unavailable, or null when it is available (or
   * when a submit is already in flight and the button speaks for itself).
   */
  disabledReason: string | null;
  /** The appointment cannot keep its current practitioner; the DB would refuse. */
  reassignmentRequired: boolean;
  /** The sentence shown beside the practitioner selector, or null. */
  reassignmentNotice: string | null;
  /** The chosen target differs from the current holder. */
  isReassign: boolean;
};

// Exported so tests assert the SAME strings the dialog renders.
export const MOVE_REASON = {
  reassignmentRequired: "Choose a practitioner to reassign this appointment.",
  loadingSlots: "Loading available times…",
  chooseSlot: "Choose a new time.",
  chooseDateAndTime: "Choose a date and time.",
  chooseDate: "Choose a date.",
  chooseTime: "Choose a time.",
  acknowledge: "Confirm that you want to override regular availability.",
  noChange: "Choose a different time to move this appointment.",
} as const;

export const MOVE_NOTICE = {
  ineligibleHolder:
    "This appointment's practitioner is no longer active or eligible. Choose a practitioner to reassign it.",
  unassigned: "This appointment has no assigned practitioner. Choose a practitioner to reassign it.",
} as const;

export function moveConfirmState(input: MoveConfirmInput): MoveConfirmState {
  const {
    mode,
    submitting,
    reassignEnabled,
    eligibleIds,
    target,
    currentPractitionerId,
    hasSlot,
    loadingSlots,
    date,
    customTime,
    ackOverride,
    timeChanged,
  } = input;

  // Fail closed: with reassignment enabled the target must be a RESOLVED
  // eligible practitioner. An empty or failed lookup leaves it unresolved.
  const targetChosen = !reassignEnabled || eligibleIds.includes(target);
  const isReassign = reassignEnabled && !!target && target !== currentPractitionerId;

  // The current holder cannot carry the appointment forward. Deliberately NOT
  // gated on a non-empty current id — the old gate was, and would have shown
  // nothing at all for a NULL holder. That arm is DEFENSIVE rather than live:
  // `appointments_capacity_requires_practitioner` (0134) forbids an unassigned
  // CONFIRMED appointment on a capacity-ON studio, and reassignment is only
  // enabled when capacity is ON. Proved by the negative control in
  // e2e/move-appointment-custom-time.spec.ts; kept so the gate stays correct if
  // that constraint is ever relaxed.
  const reassignmentRequired = reassignEnabled && !eligibleIds.includes(currentPractitionerId);
  const reassignmentNotice = !reassignmentRequired
    ? null
    : currentPractitionerId
      ? MOVE_NOTICE.ineligibleHolder
      : MOVE_NOTICE.unassigned;

  const blocked = (disabledReason: string | null): MoveConfirmState => ({
    canConfirm: false,
    disabledReason,
    reassignmentRequired,
    reassignmentNotice,
    isReassign,
  });

  // A submit in flight disables everything; the button already reads "Moving…",
  // so a second sentence beside it would be noise.
  if (submitting) return blocked(null);

  // The server precondition comes first: no time entry can satisfy it.
  if (!targetChosen) return blocked(MOVE_REASON.reassignmentRequired);

  if (mode === "available_slot") {
    if (loadingSlots) return blocked(MOVE_REASON.loadingSlots);
    if (!hasSlot) return blocked(MOVE_REASON.chooseSlot);
  } else {
    const validDate = DATE_RE.test(date);
    const validTime = TIME_RE.test(customTime);
    if (!validDate && !validTime) return blocked(MOVE_REASON.chooseDateAndTime);
    if (!validDate) return blocked(MOVE_REASON.chooseDate);
    if (!validTime) return blocked(MOVE_REASON.chooseTime);
    if (!ackOverride) return blocked(MOVE_REASON.acknowledge);
  }

  // Everything is entered and authorized — but nothing actually changes.
  if (!timeChanged && !isReassign) return blocked(MOVE_REASON.noChange);

  return {
    canConfirm: true,
    disabledReason: null,
    reassignmentRequired,
    reassignmentNotice,
    isReassign,
  };
}

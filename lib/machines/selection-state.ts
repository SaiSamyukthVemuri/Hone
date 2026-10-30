// MPX-03 — what the panel may CLAIM about a machine selection.
//
// WHY THIS IS ITS OWN MODULE. The same status line has now been wrong twice,
// in two different ways, and both times the defect was in a three-line state
// update inside a client component - the one shape this repository cannot test
// interactively, because there is no jsdom or testing-library in the unit
// stack (by design: interaction is proved in Playwright). So the rule lives
// here, as a pure function with an exhaustive truth table in
// tests/lib/machines/selection-state.test.ts, and the component does nothing
// but apply it.
//
// THE TWO FAILURES, because they are the reason for every line below:
//
//   1. The line read `persistence.persisted` - the store's CAPABILITY. That
//      answers "can a choice be kept?", not "is one kept?", so it said
//      "Remembered: yes" to every practitioner with a working database before
//      any machine had been chosen (Codex, a66f5ec9).
//
//   2. Repaired to read the SELECTION, which is optimistic: it moves before
//      the write and stays moved when the write fails. So a failed save still
//      said "yes", and a failed CLEAR said "nothing remembered" while the old
//      database default was still there (Codex, 7cae831b).
//
// The shared mistake is reporting something ADJACENT to the stored fact.
// Capability is not the fact; intent is not the fact. `persisted` here moves
// only on an acknowledged write, and nothing else may move it.

/** The outcome of a persistence attempt, as the server action reports it. */
export type SelectionWrite = { ok: true } | { ok: false; error?: string };

export type SelectionState = {
  /** What the practitioner is looking at. Moves first, so the form stays responsive. */
  selected: string | null;
  /** What the store actually holds. Moves ONLY on an acknowledged write. */
  persisted: string | null;
  /** What to tell them when those two disagree, or null. */
  note: string | null;
};

/**
 * A FAILED CLEAR NEEDS ITS OWN WORDING, which is the half that was missing.
 * "Could not be remembered" is actively misleading after a failed clear: the
 * machine IS still remembered, and that is the problem being reported.
 */
export const FAILED_CLEAR_NOTE =
  "This machine is no longer selected here, but clearing it for next time failed - it is still remembered.";

export const FAILED_SET_NOTE =
  "This machine applies to this block but could not be remembered for next time.";

export function initialSelection(deviceId: string | null): SelectionState {
  // Seeded from the server's value, which IS the stored fact at first render.
  return { selected: deviceId, persisted: deviceId, note: null };
}

/**
 * A reopened visit selected the unit its last saved capture used. The stored
 * fact stays the practitioner's own default (possibly a different unit, or
 * none): restoring a visit must not claim, or change, what is remembered.
 */
export function restoredSelection(
  selected: string,
  persisted: string | null,
): SelectionState {
  return { selected, persisted, note: null };
}

/**
 * The store holds a machine that CANNOT BE USED: retired, removed from the
 * studio, pointing at an unknown or inactive profile, or registered against a
 * contract version the catalogue has moved past.
 *
 * All three fields differ here, which is why it needs its own constructor
 * rather than a flag. The machine is genuinely still STORED - reporting
 * otherwise would be the same class of lie as the two this module already
 * records - but it is NOT selected, because nothing may be charted on it, and
 * the reason has to be said out loud. Without this the panel showed no chosen
 * machine while still reporting one as remembered, and never explained the
 * gap, even though `resolveSelection` had computed the explanation already
 * (Codex, 1a39a51f).
 */
export function unusableSelection(persisted: string, note: string): SelectionState {
  return { selected: null, persisted, note };
}

/** The optimistic move: the selection applies at once, and stale notes clear. */
export function selectionRequested(
  prev: SelectionState,
  next: string | null,
): SelectionState {
  return { selected: next, persisted: prev.persisted, note: null };
}

/**
 * The acknowledged outcome. `write` is null when no persister is wired at all.
 *
 * `persisted` is carried from `prev` in every branch except the acknowledged
 * success - including the no-persister branch, where claiming the selection as
 * stored would be the first failure again in a third costume.
 */
export function selectionSettled(
  prev: SelectionState,
  next: string | null,
  write: SelectionWrite | null,
): SelectionState {
  if (write === null) {
    return { selected: next, persisted: prev.persisted, note: null };
  }
  if (write.ok) {
    return { selected: next, persisted: next, note: null };
  }
  return {
    selected: next,
    persisted: prev.persisted,
    note: write.error ?? (next === null ? FAILED_CLEAR_NOTE : FAILED_SET_NOTE),
  };
}

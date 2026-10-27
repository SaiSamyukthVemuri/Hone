/**
 * The confirmation panel for a weekly-hours preset is cleared when that
 * preset's save finishes, but only if it is STILL the pending one. A preset the
 * owner picked while the previous save was in flight must not be wiped by the
 * earlier save settling (AVAIL-PRESET-01).
 */
export function settlePendingPreset<T>(current: T | null, confirmed: T): T | null {
  return current === confirmed ? null : current;
}

/**
 * What the confirmation panel's button says and whether it can be pressed.
 * "Applying…" belongs to the preset whose save is in flight; a panel showing a
 * DIFFERENT preset (one chosen mid-save) must not claim it is being applied,
 * and must wait: two weekly-hours saves in flight at once have no defined
 * winner. A day-hours save in flight blocks it for the same reason.
 */
export function presetConfirmControl<T>(
  pending: T | null,
  applying: T | null,
  daySaveInFlight: boolean,
): { label: string; disabled: boolean } {
  if (applying !== null && applying === pending) {
    return { label: "Applying…", disabled: true };
  }
  return { label: "Replace", disabled: applying !== null || daySaveInFlight };
}

/**
 * The confirmation panel for a weekly-hours preset is cleared when that
 * preset's save finishes, but only if it is STILL the pending one. A preset the
 * owner picked while the previous save was in flight must not be wiped by the
 * earlier save settling (AVAIL-PRESET-01).
 */
export function settlePendingPreset<T>(current: T | null, confirmed: T): T | null {
  return current === confirmed ? null : current;
}

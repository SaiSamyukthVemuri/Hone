/**
 * PER-MODE READING BAGS for the legacy modes (thermolysis, blend, galvanic).
 *
 * Shared entries (areas, probe, lot, hairs, minutes, numbing, response, notes) are NEVER here: a mode change does not touch them. Only the
 * readings that belong to a mode live in its bag. The shown mode's readings live in the draft the form already reads and saves; every other
 * mode's readings are parked in its bag, in MEMORY ONLY. So a hidden mode's value is not in a field, and cannot be saved.
 *
 * Pure: no storage, no URL, no logging, no I/O. A bag holds typed values, so it is never written anywhere.
 */

/** The reading keys that belong to a mode. EVERYTHING else on the draft is a shared entry. */
export const MODE_READING_KEYS = [
  "apilusModality",
  "energyLevel",
  "thermolysisIntensityPercent",
  "thermolysisDurationSeconds",
  "galvanicMa",
  "galvanicDurationSeconds",
  "unitsOfLye",
  "pulseCount",
  "pulseDelay",
] as const;
export type ModeReadingKey = (typeof MODE_READING_KEYS)[number];
export type ModeReadings = Record<ModeReadingKey, string>;

/** One parked mode: its readings and whether the practitioner TOUCHED the pulse controls (typed, or used the − / + stepper). */
export type ModeBag = { readings: ModeReadings; pulseTouched: boolean };
export type ModeBags = Record<string, ModeBag>;

export const PULSE_UNTOUCHED_DEFAULTS = { pulseCount: "1", pulseDelay: "0.5" } as const;

/** A fresh bag: every reading blank, the pulse controls at their untouched defaults. */
export function emptyReadings(): ModeReadings {
  return {
    apilusModality: "",
    energyLevel: "",
    thermolysisIntensityPercent: "",
    thermolysisDurationSeconds: "",
    galvanicMa: "",
    galvanicDurationSeconds: "",
    unitsOfLye: "",
    pulseCount: PULSE_UNTOUCHED_DEFAULTS.pulseCount,
    pulseDelay: PULSE_UNTOUCHED_DEFAULTS.pulseDelay,
  };
}

export function readingsOf(draft: Record<string, unknown>): ModeReadings {
  const out = emptyReadings();
  for (const k of MODE_READING_KEYS) {
    const v = draft[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Does a bag hold anything the practitioner entered? (A blank bag, or one at the untouched defaults, does not.) */
export function bagHoldsValue(bag: ModeBag | undefined): boolean {
  if (!bag) return false;
  if (bag.pulseTouched) return true;
  return MODE_READING_KEYS.some((k) => {
    if (k === "pulseCount" || k === "pulseDelay") return false;
    return bag.readings[k].trim() !== "";
  });
}

/** The modes (other than the shown one) whose parked readings hold a value. Names only, never values. */
export function hiddenModesWithValues(bags: ModeBags, shown: string): string[] {
  return Object.keys(bags).filter((m) => m !== shown && m !== "" && bagHoldsValue(bags[m]));
}

/**
 * Move from `from` to `to`: park the shown mode's readings in its bag, then load the target mode's bag (or a fresh one). Returns the NEW draft
 * (shared entries untouched, only the mode and the reading keys replaced), the new bags and the new touched flag.
 */
export function switchMode<D extends Record<string, unknown>>(
  s: { draft: D; bags: ModeBags; pulseTouched: boolean },
  to: string,
): { draft: D; bags: ModeBags; pulseTouched: boolean } {
  const from = String(s.draft.mode ?? "");
  if (from === to) return s;
  const bags: ModeBags = { ...s.bags };
  if (from !== "") bags[from] = { readings: readingsOf(s.draft), pulseTouched: s.pulseTouched };
  const incoming = to !== "" ? bags[to] : undefined;
  const readings = incoming?.readings ?? emptyReadings();
  return { draft: { ...s.draft, mode: to, ...readings }, bags, pulseTouched: incoming?.pulseTouched ?? false };
}

/** The pulse controls are RECORDED only when touched AND the shown mode has a thermolysis group. Untouched defaults are never a record. */
export function pulseRecordable(mode: string, pulseTouched: boolean): boolean {
  return pulseTouched && (mode === "thermo" || mode === "blend");
}

const MODE_NAMES: Record<string, string> = { thermo: "Thermolysis", blend: "Blend", galv: "Galvanic" };
/** "Blend readings are kept in this draft and will not be saved." No values, only the mode names. */
export function hiddenBagsNotice(modes: string[]): string | null {
  const names = modes.map((m) => MODE_NAMES[m]).filter((n): n is string => typeof n === "string");
  if (names.length === 0) return null;
  return `${names.join(" and ")} readings ${names.length > 1 ? "are" : "is"} kept in this draft and will not be saved.`;
}

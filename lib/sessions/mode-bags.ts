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

/** Whether the practitioner TOUCHED each pulse control (typed, or used the − / + stepper). Tracked SEPARATELY: a touched count never records an untouched delay. */
export type PulseTouched = { count: boolean; delay: boolean };
export const NO_PULSE_TOUCHED: PulseTouched = { count: false, delay: false };

/** A value that came FROM A RECORD (a saved entry, copy-settings, a resumed draft) is a recorded fact, so it counts as touched: an edit must write it back, never clear it. */
export function pulseTouchedFromRecord(entry: { pulse_count?: number | null; pulse_delay_seconds?: number | null } | null | undefined): PulseTouched {
  return { count: entry?.pulse_count != null, delay: entry?.pulse_delay_seconds != null };
}
export function mergeTouched(a: PulseTouched, b: PulseTouched): PulseTouched {
  return { count: a.count || b.count, delay: a.delay || b.delay };
}

/** One parked mode: its readings and which pulse controls were touched. */
export type ModeBag = { readings: ModeReadings; pulseTouched: PulseTouched };
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
  if (bag.pulseTouched.count || bag.pulseTouched.delay) return true;
  return MODE_READING_KEYS.some((k) => {
    if (k === "pulseCount" || k === "pulseDelay") return false;
    return bag.readings[k].trim() !== "";
  });
}

/** The modes (other than the shown one) whose parked readings hold a value. Names only, never values. */
export function hiddenModesWithValues(bags: ModeBags, shown: string): string[] {
  return Object.keys(bags).filter((m) => m !== shown && bagHoldsValue(bags[m]));
}

/**
 * Move from `from` to `to`: park the shown mode's readings in its bag, then load the target mode's bag (or a fresh one). Returns the NEW draft
 * (shared entries untouched, only the mode and the reading keys replaced), the new bags and the new touched flag.
 */
export function switchMode<D extends Record<string, unknown>>(
  s: { draft: D; bags: ModeBags; pulseTouched: PulseTouched },
  to: string,
): { draft: D; bags: ModeBags; pulseTouched: PulseTouched } {
  const from = String(s.draft.mode ?? "");
  if (from === to) return s;
  const bags: ModeBags = { ...s.bags };
  // The NO-MODE state is parked too: readings typed before a mode was chosen are kept (and never saved), not silently discarded at the first pick.
  bags[from] = { readings: readingsOf(s.draft), pulseTouched: s.pulseTouched };
  const incoming = bags[to];
  const readings = incoming?.readings ?? emptyReadings();
  return { draft: { ...s.draft, mode: to, ...readings }, bags, pulseTouched: incoming?.pulseTouched ?? NO_PULSE_TOUCHED };
}

/** Each pulse control is RECORDED only when ITS OWN control was touched AND the shown mode has a thermolysis group. Untouched defaults are never a record. */
export function pulseRecordable(mode: string, t: PulseTouched): { count: boolean; delay: boolean } {
  const has = mode === "thermo" || mode === "blend";
  return { count: has && t.count, delay: has && t.delay };
}

const MODE_NAMES: Record<string, string> = { thermo: "Thermolysis", blend: "Blend", galv: "Galvanic" };
/** "Blend readings are kept in this draft and will not be saved." No values, only the mode names. */
export function hiddenBagsNotice(modes: string[]): string | null {
  const names = modes.map((m) => MODE_NAMES[m]).filter((n): n is string => typeof n === "string");
  const parts: string[] = [];
  if (names.length > 0) parts.push(`${names.join(" and ")} readings ${names.length > 1 ? "are" : "is"} kept in this draft and will not be saved.`);
  if (modes.includes("")) parts.push("Readings entered before a mode was chosen are kept in this draft and will not be saved.");
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Whether the touched flags differ from what the saved record implies (so a touch with no visible change still counts as an unsaved edit). */
export function pulseTouchedDiffersFromRecord(t: PulseTouched, entry: Parameters<typeof pulseTouchedFromRecord>[0]): boolean {
  const base = pulseTouchedFromRecord(entry);
  return t.count !== base.count || t.delay !== base.delay;
}

// Hardcoded preset values used during entry. These will move to studio settings later.

// Flat list retained for backwards compatibility with session-entry
// chip pickers that already index into it. Body Chart v1 (migration
// 0038) adds Jawline, Sideburns, and Eyebrows so practitioner-frequent
// areas have first-class entries.
export const AREAS: ReadonlyArray<string> = [
  "Upper lip",
  "Chin",
  "Jawline",
  "Cheeks",
  "Sideburns",
  "Eyebrows",
  "Full face",
  "Neck",
  "Ears",
  "Chest",
  "Abdomen",
  "Back",
  "Underarms",
  "Forearms",
  "Hands",
  "Thighs",
  "Lower legs",
  "Feet",
  "Bikini",
  "Brazilian",
  "Buttocks",
  "Other",
];

// Region-grouped area taxonomy used by the treatment plan area picker
// (Body Chart v1 Phase A). Same canonical strings as AREAS minus
// "Full face" (which is a composite: practitioners should pick a
// specific area for a treatment plan), grouped for picker navigation.
// "Other" is a catch-all that unlocks a custom free-text value in the
// UI; the DB column accepts any 1..60 char string.
export const AREA_REGIONS: ReadonlyArray<{
  region: string;
  areas: ReadonlyArray<string>;
}> = [
  {
    region: "Face & neck",
    areas: [
      "Upper lip",
      "Chin",
      "Jawline",
      "Cheeks",
      "Sideburns",
      "Eyebrows",
      "Neck",
      "Ears",
    ],
  },
  {
    region: "Torso",
    areas: ["Chest", "Abdomen", "Back", "Underarms"],
  },
  {
    region: "Limbs",
    areas: ["Forearms", "Hands", "Thighs", "Lower legs", "Feet"],
  },
  {
    region: "Intimate",
    areas: ["Bikini", "Brazilian", "Buttocks"],
  },
];

export const OTHER_AREA = "Other";

// Laser treatments use larger anatomical zones; overlap with AREAS but not identical.
export const LASER_ZONES: ReadonlyArray<string> = [
  "Upper lip",
  "Chin",
  "Cheeks",
  "Full face",
  "Sideburns",
  "Neck",
  "Chest",
  "Stomach",
  "Back",
  "Underarms",
  "Bikini",
  "Brazilian",
  "Buttocks",
  "Forearms",
  "Full arms",
  "Thighs",
  "Lower legs",
  "Full legs",
  "Hands",
  "Feet",
  "Other",
];

export const PROBE_SIZES: ReadonlyArray<string> = [
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
];

// Order matches the typical electrolysis machine UI: Thermolysis, Blend, Galvanic.
export const ELECTROLYSIS_MODES: ReadonlyArray<{
  value: "thermo" | "galv" | "blend";
  label: string;
}> = [
  { value: "thermo", label: "Thermolysis" },
  { value: "blend", label: "Blend" },
  { value: "galv", label: "Galvanic" },
];

export const FITZPATRICK_TYPES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "I" },
  { value: 2, label: "II" },
  { value: 3, label: "III" },
  { value: 4, label: "IV" },
  { value: 5, label: "V" },
  { value: 6, label: "VI" },
];

// Quick-tap comment chips for electrolysis entries. Theresa will replace with the real list later.
//
// Vocabulary cleanup (Chloe): the two clinical-jargon-only terms now pair plain
// language with the medical term so there is ONE unambiguous option per concept
// ("Redness (erythema)", "Slight swelling (edema)") instead of jargon Chloe read
// as redundant with plain wording. These are DISPLAY/canonical LABEL changes;
// legacy stored values ("Erythema", "Slight edema") keep resolving via the alias
// map in lib/observation-chips.ts, no production row is rewritten, no backfill.
export const COMMON_COMMENTS: ReadonlyArray<string> = [
  "Dehydrated follicles",
  "Hyperpigmentation",
  "Sensitive skin",
  "Coarse hair",
  "Fine hair",
  "Deep follicles",
  "Curved follicles",
  "Redness (erythema)",
  "Slight swelling (edema)",
  "Client tolerated well",
  "Lots of anagen",
  "Lots of catagen",
  "Lots of telogen",
  "Shallow follicles",
];

// Apilus sub-modalities, scoped by electrolysis mode. Galvanic has no
// sub-modality, so it's intentionally absent from the map.
export const APILUS_MODALITIES_BY_MODE: Record<
  "thermo" | "blend",
  ReadonlyArray<string>
> = {
  // Order is practitioner-preferred (Chloe), not alphabetical. Values are
  // the stored/canonical strings (unchanged); see APILUS_MODALITY_LABELS
  // for the clean display names. ThermoFlash sits last as older tech;
  // MicroFlash (not in the requested shortlist) is kept selectable just
  // above it so existing entries that use it still have an option.
  thermo: [
    "Picoflash",
    "Meloflash",
    "Multiplex",
    "Synchro",
    "Microflash",
    "Thermoflash",
  ],
  blend: [
    "Picoblend",
    "Omniblend",
    "Multiblend",
    "Evolublend",
    "Synchroblend",
  ],
};

export const ALL_APILUS_MODALITIES: ReadonlyArray<string> = [
  ...APILUS_MODALITIES_BY_MODE.thermo,
  ...APILUS_MODALITIES_BY_MODE.blend,
];

// Display-only labels for Apilus modalities. The stored/canonical values
// (the ApilusModality union and existing electrolysis_entries /
// session_blocks rows) keep their original casing for backward
// compatibility: this map only changes what practitioners see. Unknown or
// legacy values fall through to the raw value so historical entries always
// render. No data migration.
export const APILUS_MODALITY_LABELS: Readonly<Record<string, string>> = {
  Picoflash: "PicoFlash",
  Meloflash: "MeloFlash",
  Multiplex: "MultiPlex",
  Synchro: "Synchro",
  Microflash: "MicroFlash",
  Thermoflash: "ThermoFlash",
  Picoblend: "PicoBlend",
  Omniblend: "OmniBlend",
  Multiblend: "MultiBlend",
  Evolublend: "Evolution Blend",
  Synchroblend: "SynchroBlend",
};

export function apilusModalityLabel(value: string | null | undefined): string {
  if (!value) return "";
  return APILUS_MODALITY_LABELS[value] ?? value;
}

export const PROBE_TYPES: ReadonlyArray<string> = [
  "Stainless steel regular",
  "Stainless steel gold",
  "IBL",
  "ITH",
];

export const MACHINE_FREQUENCIES: ReadonlyArray<string> = [
  "13.56 MHz",
  "27.12 MHz",
];

// Quick-tap observation chips for laser entries. Theresa will replace with the real list later.
export const LASER_OBSERVATION_CHIPS: ReadonlyArray<string> = [
  "Follicular erythema",
  "Follicular edema",
  "Very sensitive",
  "Client tolerated well",
  "Mild redness",
  "Some discomfort",
];

// Quick-tap chips for the client intake "Allergies" field.
export const COMMON_ALLERGIES: ReadonlyArray<string> = [
  "Nickel / metal sensitivity",
  "Latex",
  "Fragrance / perfume",
  "Topical anesthetic (lidocaine, benzocaine)",
  "Adhesive bandages",
  "Hydrogen peroxide",
  "Aloe",
];

// Quick-tap chips for the client intake "Skin notes" field.
export const COMMON_SKIN_CONDITIONS: ReadonlyArray<string> = [
  "Acne-prone",
  "Rosacea",
  "Hidradenitis suppurativa",
  "Eczema / atopic dermatitis",
  "Psoriasis",
  "Hyperpigmentation tendency",
  "Hypopigmentation tendency",
  "Keloid scarring history",
  "Recent sun exposure",
  "Currently pregnant",
];

export const FLUENCE_MIN = 1;
export const FLUENCE_MAX = 100;
// Chloe always starts clients at 30 and adjusts from there.
export const FLUENCE_DEFAULT = 30;

export const PULSE_COUNT_MIN = 1;
export const PULSE_COUNT_MAX = 10;
export const PULSE_COUNT_DEFAULT = 1;

// Pulse delay (seconds) between high-frequency pulses, recorded only when
// multiple pulses are done (pulse_count > 1). Chloe's machine: range
// 0.03–1.90s, auto-set to 0.5s. Two decimal places.
export const PULSE_DELAY_MIN = 0.03;
export const PULSE_DELAY_MAX = 1.9;
export const PULSE_DELAY_DEFAULT = 0.5;
export const PULSE_DELAY_RANGE_ERROR =
  "Pulse delay must be between 0.03 and 1.90 seconds.";

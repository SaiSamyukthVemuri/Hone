// Hardcoded preset values used during entry. These will move to studio settings later.

export const AREAS: ReadonlyArray<string> = [
  "Upper lip",
  "Chin",
  "Cheeks",
  "Full face",
  "Neck",
  "Chest",
  "Back",
  "Underarms",
  "Bikini",
  "Brazilian",
  "Buttocks",
  "Forearms",
  "Thighs",
  "Lower legs",
  "Hands",
  "Feet",
  "Abdomen",
  "Ears",
  "Other",
];

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
export const COMMON_COMMENTS: ReadonlyArray<string> = [
  "Dehydrated follicles",
  "Hyperpigmentation",
  "Sensitive skin",
  "Coarse hair",
  "Fine hair",
  "Deep follicles",
  "Curved follicles",
  "Erythema",
  "Slight edema",
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
  thermo: [
    "Multiplex",
    "Microflash",
    "Picoflash",
    "Synchro",
    "Thermoflash",
    "Meloflash",
  ],
  blend: [
    "Evolublend",
    "Omniblend",
    "Picoblend",
    "Synchroblend",
    "Multiblend",
  ],
};

export const ALL_APILUS_MODALITIES: ReadonlyArray<string> = [
  ...APILUS_MODALITIES_BY_MODE.thermo,
  ...APILUS_MODALITIES_BY_MODE.blend,
];

export const PROBE_TYPES: ReadonlyArray<string> = ["Regular", "IBL", "ITH"];

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

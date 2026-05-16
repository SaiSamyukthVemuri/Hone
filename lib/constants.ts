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

export const PROBE_SIZES: ReadonlyArray<string> = ["F2", "F3", "F4", "F5", "F6"];

export const ELECTROLYSIS_MODES: ReadonlyArray<{
  value: "thermo" | "galv" | "blend";
  label: string;
}> = [
  { value: "thermo", label: "Thermolysis" },
  { value: "galv", label: "Galvanic" },
  { value: "blend", label: "Blend" },
];

export const FITZPATRICK_TYPES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "I" },
  { value: 2, label: "II" },
  { value: 3, label: "III" },
  { value: 4, label: "IV" },
  { value: 5, label: "V" },
  { value: 6, label: "VI" },
];

// THE canonical order of the machine readings, for every charting surface.
//
// WHY THIS EXISTS
// ---------------
// Chloe reads values off the Apilus screen top-to-bottom and types them in.
// Every surface that captured or displayed these readings had drifted into its
// own order: the one-page form put thermolysis before galvanic, "Add another
// pass" put intensity before duration, the copy card used a third order, and
// the saved-record row used a fourth. Each one forced her to hunt for the next
// field instead of reading straight down the machine.
//
// The order below IS the machine's physical order. It is stated once here so a
// new surface (or an edit to an old one) cannot silently disagree; the pins in
// tests/app/sessions/blend-machine-field-order.test.ts assert every active
// surface against this list.
//
// This module is ordering ONLY. It deliberately owns no validation, no ranges,
// no mode semantics and no storage concerns: reordering the UI must not be able
// to change what is stored or accepted.

export type ReadingField =
  | "energyLevel"
  | "unitsOfLye"
  | "galvanicDurationSeconds"
  | "galvanicMa"
  | "thermolysisDurationSeconds"
  | "thermolysisIntensityPercent"
  | "pulseCount"
  | "pulseDelay";

// Blend (and every blend modality: PicoBlend, OmniBlend, MultiBlend,
// EvoluBlend, SynchroBlend), the full machine order.
export const MACHINE_READING_ORDER: readonly ReadingField[] = [
  "energyLevel",
  // Units of lye sits with EL at the top, and opens the galvanic group.
  "unitsOfLye",
  "galvanicDurationSeconds",
  "galvanicMa",
  // Galvanic group complete; thermolysis follows.
  "thermolysisDurationSeconds",
  "thermolysisIntensityPercent",
  "pulseCount",
  // Only rendered when more than one pulse is charted.
  "pulseDelay",
] as const;

// The visible label each field carries in the capture forms. Pinned here so a
// label edit and an order pin can never drift apart.
export const READING_FIELD_LABELS: Readonly<Record<ReadingField, string>> = {
  energyLevel: "Energy level (EL)",
  unitsOfLye: "Units of lye (UL)",
  galvanicDurationSeconds: "Galvanic duration (s)",
  galvanicMa: "Galvanic mA",
  thermolysisDurationSeconds: "Thermolysis duration (s)",
  thermolysisIntensityPercent: "Thermolysis intensity %",
  pulseCount: "Thermolysis pulse count",
  pulseDelay: "Pulse delay",
};

const GALVANIC_FIELDS: ReadonlySet<ReadingField> = new Set([
  "unitsOfLye",
  "galvanicDurationSeconds",
  "galvanicMa",
]);

const THERMOLYSIS_FIELDS: ReadonlySet<ReadingField> = new Set([
  "thermolysisDurationSeconds",
  "thermolysisIntensityPercent",
  "pulseCount",
  "pulseDelay",
]);

// Which fields a mode shows, in machine order. This mirrors the mode gating the
// forms already applied (lib/sessions/mode-sections.ts). It does not change it:
//   * pure galvanic has no energy level and no thermolysis readings;
//   * pure thermolysis has no units of lye and no galvanic readings;
//   * blend shows everything.
// `omniblend` drops thermolysis duration: that machine has none. `pulseDelay` is
// listed whenever the mode supports pulses; the form still renders it only when
// more than one pulse is charted.
//
// KNOWN, DELIBERATE DIVERGENCE: for pure galvanic this returns no energy level
// (matching the data layer: buildTreatmentSetupDraftPatch blanks energy_level
// for galv), but the one-page charting form still RENDERS the energy-level input
// in every mode. Hiding it would be a mode-gating change, which the machine-order
// work deliberately does not make; the current behaviour is pinned in
// e2e/blend-machine-order-mobile.spec.ts so it stays visible rather than assumed.
export function readingFieldOrder(
  mode: string | null | undefined,
  opts: { omniblend?: boolean } = {},
): ReadingField[] {
  const m = (mode ?? "").trim();
  const wantGalv = m === "galv" || m === "blend";
  const wantThermo = m === "thermo" || m === "blend";
  return MACHINE_READING_ORDER.filter((f) => {
    if (f === "energyLevel") return m !== "galv";
    if (GALVANIC_FIELDS.has(f)) return wantGalv;
    if (THERMOLYSIS_FIELDS.has(f)) {
      if (!wantThermo) return false;
      if (f === "thermolysisDurationSeconds" && opts.omniblend) return false;
      return true;
    }
    return true;
  });
}

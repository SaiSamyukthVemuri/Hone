/**
 * THE SERVER'S RULE for which reading fields belong to a submitted mode (chart redesign, W2).
 *
 * The browser hides fields that do not belong to the shown mode, but a hidden field is a convenience: a forged or stale request can still carry
 * one. With the redesign on for a studio, every write path (create, edit, add-pass) passes its input through here first, so a field that does not
 * belong to the mode is DROPPED to null before anything is shaped or stored, whatever the client sent.
 *
 *   no mode  -> no readings at all (no modality, no EL, nothing from any group); shared entries (hairs, notes, chips) are not readings
 *   thermo   -> modality, EL, thermolysis group, pulse
 *   blend    -> everything (thermolysis, galvanic, UL, modality, EL, pulse); OmniBlend has no thermolysis duration
 *   galv     -> galvanic group, UL and EL (Sam's ruling: Galvanic saves EL); no modality, no thermolysis, no pulse
 *
 * Pure. The caller decides whether the redesign is on; with it off this module is not called and every write is exactly as it was.
 */

export type ScopableInput = {
  mode?: string | null;
  apilusModality?: string | null;
  energyLevel?: number | null;
  readings?: {
    pulseCount?: number | null;
    pulseDelaySeconds?: number | null;
    galvanicMa?: number | null;
    galvanicDurationSeconds?: number | null;
    thermolysisIntensityPercent?: number | null;
    thermolysisDurationSeconds?: number | null;
    unitsOfLye?: number | null;
    [k: string]: unknown;
  };
};

export type ModeGroups = { thermolysis: boolean; galvanic: boolean; modality: boolean; energy: boolean; pulse: boolean };

export function groupsForMode(mode: string | null | undefined): ModeGroups {
  const m = (mode ?? "").trim();
  return {
    thermolysis: m === "thermo" || m === "blend",
    galvanic: m === "galv" || m === "blend",
    modality: m === "thermo" || m === "blend",
    energy: m === "thermo" || m === "blend" || m === "galv",
    pulse: m === "thermo" || m === "blend",
  };
}

/** OmniBlend is a blend modality with no thermolysis duration (the form hides it; the server drops it). */
export function isOmniblend(mode: string | null | undefined, modality: string | null | undefined): boolean {
  return (mode ?? "").trim() === "blend" && (modality ?? "").trim().toLowerCase() === "omniblend";
}

export function scopeToMode<T extends ScopableInput>(input: T): T {
  const g = groupsForMode(input.mode);
  const r = input.readings ?? {};
  const modality = g.modality ? (input.apilusModality ?? null) : null;
  const omni = isOmniblend(input.mode, modality);
  return {
    ...input,
    apilusModality: modality,
    energyLevel: g.energy ? (input.energyLevel ?? null) : null,
    readings: {
      ...r,
      thermolysisIntensityPercent: g.thermolysis ? (r.thermolysisIntensityPercent ?? null) : null,
      thermolysisDurationSeconds: g.thermolysis && !omni ? (r.thermolysisDurationSeconds ?? null) : null,
      galvanicMa: g.galvanic ? (r.galvanicMa ?? null) : null,
      galvanicDurationSeconds: g.galvanic ? (r.galvanicDurationSeconds ?? null) : null,
      unitsOfLye: g.galvanic ? (r.unitsOfLye ?? null) : null,
      pulseCount: g.pulse ? (r.pulseCount ?? null) : null,
      pulseDelaySeconds: g.pulse ? (r.pulseDelaySeconds ?? null) : null,
    },
  };
}

/** Does any reading group hold a value? (used by the freeze rule) */
export function entryHasReadings(e: Record<string, unknown> | null | undefined): boolean {
  if (!e) return false;
  return [
    "thermolysis_intensity_percent", "thermolysis_duration_seconds", "galvanic_ma", "galvanic_duration_seconds",
    "units_of_lye", "energy_level", "apilus_modality",
  ].some((k) => e[k] != null);
}

/** W4: a block that holds readings keeps its mode. */
export function modeChangeRefused(o: { storedMode: string | null; submittedMode: string | null; hasReadings: boolean }): boolean {
  const a = (o.storedMode ?? "") || null;
  const b = (o.submittedMode ?? "") || null;
  return o.hasReadings && a !== b;
}
export const MODE_FROZEN_MESSAGE = "This area already has readings recorded, so its mode can't be changed. Add a new settings block for a different mode.";

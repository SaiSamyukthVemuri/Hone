// Canonical reusable "treatment setup" snapshot.
//
// This is CURRENTLY the authoritative field contract for the in-form "Copy
// settings" control (the only copy surface active today). It is deliberately
// written to become the SHARED contract for the future migration-first
// whole-session "Copy areas and settings" DRAFT workflow when that lands, so the
// two surfaces cannot drift — but that whole-session workflow does not exist
// yet, so today only the in-form control consumes this module.
//
// A treatment-setup snapshot is the machine/probe SETUP a practitioner reuses
// from one session to the next. It is NOT the treatment outcome. It therefore
// carries ONLY reusable setup fields and NEVER any field that describes what
// actually happened to the client:
//   NEVER: hairs_treated, comments, observation_chips, tolerance/reaction/
//   caution, numbing_status, probe_lot_number/confirmed/id, next-session notes,
//   consultation notes, photos, timestamps, author/creator ids, finalized/void/
//   audit fields, or any source entry/block/session id as a destination id.
//
// Mode gating mirrors the write path (block-actions.ts structuredReadingColumns
// + entryMachineSnapshot) EXACTLY so a copied snapshot is byte-compatible with a
// normally-charted one:
//   - thermolysis  -> thermolysis reading fields only
//   - galvanic     -> galvanic reading fields + units_of_lye only; apilus
//                     modality and energy level are cleared (galvanic carries
//                     neither)
//   - blend        -> both reading groups; apilus/energy carried
//   - single pulse (pulse_count === 1) -> no pulse delay
// Fields invalid for the resulting mode are emitted blank (never guessed).

export type SessionMode = "thermo" | "galv" | "blend";

// The reusable machine readings that live on the primary electrolysis_entries
// row (mode-gated). Named here so the form draft stays in lockstep with this
// module, and so the future whole-session draft workflow can reuse the same
// field set. (No copy RPC exists yet; this is not a live RPC allowlist.)
// NOTE: galvanic_intensity_percent is DELIBERATELY absent. It is a retired
// active input (Chloe / PicoBlend): new entries never store it and no current
// form edits it, so it is not reusable setup and must never be copied into a new
// draft. Historical stored values are preserved untouched server-side; they are
// simply not part of the reusable-setup contract.
export const ENTRY_SETUP_FIELDS = [
  "thermolysis_intensity_percent",
  "thermolysis_duration_seconds",
  "galvanic_ma",
  "galvanic_duration_seconds",
  "units_of_lye",
  "pulse_count",
  "pulse_delay_seconds",
] as const;

// The reusable setup that lives on the session_blocks row.
export const BLOCK_SETUP_FIELDS = [
  "mode",
  "apilus_modality",
  "energy_level",
  "minutes_performed",
  "machine_frequency",
  "probe_key",
  "probe_brand",
  "probe_material",
  "probe_piece_type",
  "probe_shank",
  "probe_size_value",
  "probe_length",
  "probe_label",
] as const;

// Minimal structural source shapes (decoupled from the DB row types).
export type SetupSourceBlock = {
  mode: string | null;
  apilus_modality: string | null;
  energy_level: number | null;
  minutes_performed: number | null;
  machine_frequency: string | null;
  probe_key: string | null;
};

// galvanic_intensity_percent is intentionally NOT part of the source contract:
// it is never read for a copy (retired input). A richer DB row that still
// carries the column satisfies this shape structurally.
export type SetupSourceEntry = {
  created_at: string;
  deleted_at: string | null;
  mode: string | null;
  thermolysis_intensity_percent: number | null;
  thermolysis_duration_seconds: number | null;
  galvanic_ma: number | null;
  galvanic_duration_seconds: number | null;
  units_of_lye: number | null;
  pulse_count: number | null;
  pulse_delay_seconds: number | null;
};

// The snapshot as the FORM draft consumes it: every value is the empty string
// when absent/invalid-for-mode, mirroring the draft's string fields. Area
// identity and all outcome fields are deliberately absent from this type.
export type TreatmentSetupDraftPatch = {
  mode: string;
  apilusModality: string;
  energyLevel: string;
  probeKey: string;
  machineFrequency: string;
  minutes: string;
  thermolysisIntensityPercent: string;
  thermolysisDurationSeconds: string;
  galvanicMa: string;
  galvanicDurationSeconds: string;
  // galvanicIntensityPercent is intentionally absent — a retired input is never
  // copied into a new draft (see ENTRY_SETUP_FIELDS).
  unitsOfLye: string;
  pulseCount: string;
  pulseDelay: string;
};

function s(n: number | null | undefined): string {
  return n != null ? String(n) : "";
}

// Earliest non-deleted entry (the canonical one-page-form settings source),
// ordered by created_at ascending. Returns null when the block has no live entry.
export function firstLiveEntry<T extends SetupSourceEntry>(
  entries: readonly T[] | null | undefined,
): T | null {
  if (!entries || entries.length === 0) return null;
  const live = entries.filter((e) => e.deleted_at == null);
  if (live.length === 0) return null;
  return [...live].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )[0];
}

// Build the reusable-setup patch a form draft applies. `block` supplies the
// block-level setup; `firstEntry` supplies the mode-gated machine readings. The
// resulting mode is the block's mode (falling back to the entry's) — readings
// are gated on THAT resulting mode, never on which source columns happened to be
// populated.
export function buildTreatmentSetupDraftPatch(
  block: SetupSourceBlock,
  firstEntry: SetupSourceEntry | null,
): TreatmentSetupDraftPatch {
  const mode = ((block.mode ?? firstEntry?.mode) ?? "") as string;
  const isGalv = mode === "galv";
  const wantThermo = mode === "thermo" || mode === "blend";
  const wantGalv = mode === "galv" || mode === "blend";

  // Single pulse carries no pulse delay.
  const pulseCount = firstEntry?.pulse_count ?? null;
  const pulseDelay =
    pulseCount != null && pulseCount <= 1 ? "" : s(firstEntry?.pulse_delay_seconds);

  return {
    mode,
    // Galvanic has no apilus modality or energy level.
    apilusModality: isGalv ? "" : (block.apilus_modality ?? ""),
    energyLevel: isGalv ? "" : s(block.energy_level),
    probeKey: block.probe_key ?? "",
    machineFrequency: block.machine_frequency ?? "",
    minutes: s(block.minutes_performed),
    thermolysisIntensityPercent: wantThermo
      ? s(firstEntry?.thermolysis_intensity_percent)
      : "",
    thermolysisDurationSeconds: wantThermo
      ? s(firstEntry?.thermolysis_duration_seconds)
      : "",
    galvanicMa: wantGalv ? s(firstEntry?.galvanic_ma) : "",
    galvanicDurationSeconds: wantGalv ? s(firstEntry?.galvanic_duration_seconds) : "",
    // galvanic_intensity_percent is retired: never copied, even from a historical
    // source that still carries a value. New entries always store NULL server-side.
    unitsOfLye: wantGalv ? s(firstEntry?.units_of_lye) : "",
    pulseCount: s(pulseCount),
    pulseDelay,
  };
}

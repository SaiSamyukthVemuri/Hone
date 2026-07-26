// Whole-session "Copy areas and settings from last session" — pure preview +
// commit-spec logic (migration 0157). This module is client-safe and performs NO
// I/O: it turns the PREVIOUS session's blocks into ephemeral preview cards, and
// a reviewed card into the RPC payload. All persistence happens only when the
// practitioner explicitly commits (copy_session_setup RPC).
//
// SETUP-ONLY: the copy carries the reusable machine/probe SETUP (from the
// canonical treatment-setup-snapshot contract) plus the treated AREA. It NEVER
// carries an outcome (comments, observation_chips, hairs_treated, tolerance,
// reaction, caution, numbing, probe lot, next-visit note). The RPC enforces this
// again with its own INSERT allow-list, so a copy is setup-only by construction.

import {
  buildTreatmentSetupDraftPatch,
  firstLiveEntry,
  type SetupSourceBlock,
  type SetupSourceEntry,
  type TreatmentSetupDraftPatch,
} from "./treatment-setup-snapshot";

export type CopySourceArea = { area: string; laterality: string };

// The block-level probe catalog columns (kept alongside the mode-gated setup so
// a copied block reproduces the exact probe the source used).
export type CopySourceProbe = {
  probe_brand: string | null;
  probe_material: string | null;
  probe_piece_type: string | null;
  probe_shank: string | null;
  probe_size_value: number | null;
  probe_length: string | null;
  probe_label: string | null;
};

// One source block (from the previous session) the preview is built from.
export type CopySourceBlock = {
  blockId: string;
  primary_area: string | null;
  side: string | null;
  custom_area_detail: string | null;
  block: SetupSourceBlock;
  probe: CopySourceProbe;
  firstEntry: SetupSourceEntry | null;
  areas: CopySourceArea[];
};

// A preview card the practitioner reviews (EPHEMERAL — lives only in component
// state; editing/removing it performs no write).
export type CopyAreaDraft = {
  key: string;
  primaryArea: string | null;
  side: string | null;
  customAreaDetail: string | null;
  areas: CopySourceArea[];
  setup: TreatmentSetupDraftPatch;
  probe: CopySourceProbe;
};

// Build the ephemeral preview from the previous session's blocks. Blocks with no
// treated area are skipped (nothing to copy). Pure — no I/O.
export function buildCopyDrafts(
  source: readonly CopySourceBlock[],
): CopyAreaDraft[] {
  const drafts: CopyAreaDraft[] = [];
  for (let i = 0; i < source.length; i++) {
    const b = source[i];
    const hasArea =
      (b.areas && b.areas.length > 0) || (b.primary_area ?? "").trim() !== "";
    if (!hasArea) continue;
    drafts.push({
      key: b.blockId || String(i),
      primaryArea: b.primary_area,
      side: b.side,
      customAreaDetail: b.custom_area_detail,
      areas: b.areas.map((a) => ({ area: a.area, laterality: a.laterality })),
      setup: buildTreatmentSetupDraftPatch(
        b.block,
        firstLiveEntry(b.firstEntry ? [b.firstEntry] : []),
      ),
      probe: b.probe,
    });
  }
  return drafts;
}

// The RPC payload for ONE reviewed draft. SETUP-only: block setup + area + entry
// SETUP readings. No outcome key is ever emitted here (and the RPC ignores any
// that somehow appears).
export type WholeSessionCopySpec = {
  block: Record<string, unknown>;
  areas: { area: string; laterality: string; display_order: number }[];
  entry: Record<string, unknown> | null;
};

function num(s: string | null | undefined): number | null {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function str(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

export function draftToCopySpec(d: CopyAreaDraft): WholeSessionCopySpec {
  const s = d.setup;
  const mode = str(s.mode);
  // s is already mode-gated by buildTreatmentSetupDraftPatch (galvanic cleared
  // apilus/energy; thermo cleared galvanic; single pulse cleared delay), so we
  // read its values straight through.
  const block: Record<string, unknown> = {
    mode,
    apilus_modality: str(s.apilusModality),
    energy_level: num(s.energyLevel),
    minutes_performed: num(s.minutes),
    machine_frequency: str(s.machineFrequency),
    probe_key: str(s.probeKey),
    probe_brand: d.probe.probe_brand,
    probe_material: d.probe.probe_material,
    probe_piece_type: d.probe.probe_piece_type,
    probe_shank: d.probe.probe_shank,
    probe_size_value: d.probe.probe_size_value,
    probe_length: d.probe.probe_length,
    probe_label: d.probe.probe_label,
    primary_area: str(d.primaryArea),
    side: str(d.side),
    custom_area_detail: str(d.customAreaDetail),
  };
  const areas = d.areas
    .filter((a) => (a.area ?? "").trim() !== "")
    .map((a, i) => ({ area: a.area, laterality: a.laterality, display_order: i }));
  const primaryAreaName = areas[0]?.area ?? str(d.primaryArea);
  const entry: Record<string, unknown> | null = primaryAreaName
    ? {
        area: primaryAreaName,
        areas: areas.length ? areas.map((a) => a.area) : [primaryAreaName],
        mode,
        apilus_modality: str(s.apilusModality),
        energy_level: num(s.energyLevel),
        minutes_performed: num(s.minutes),
        machine_frequency: str(s.machineFrequency),
        thermolysis_intensity_percent: num(s.thermolysisIntensityPercent),
        thermolysis_duration_seconds: num(s.thermolysisDurationSeconds),
        galvanic_ma: num(s.galvanicMa),
        galvanic_duration_seconds: num(s.galvanicDurationSeconds),
        galvanic_intensity_percent: num(s.galvanicIntensityPercent),
        units_of_lye: num(s.unitsOfLye),
        pulse_count: num(s.pulseCount),
        pulse_delay_seconds: num(s.pulseDelay),
      }
    : null;
  return { block, areas, entry };
}

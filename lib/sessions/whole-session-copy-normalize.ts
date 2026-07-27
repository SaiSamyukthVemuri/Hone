// Whole-session "Copy areas and settings" — CANONICAL server-side normalizer
// (migration 0157). This is the single place a browser-supplied copy draft is
// turned into the SQL spec the RPC inserts. It is PURE (no I/O) so it is unit
// tested directly, and it is the authority the commit server action runs before
// it ever reaches the database.
//
// WHY THIS EXISTS (P1-4): the browser must not mass-assign clinical columns. The
// draft cards are editable, so every value is re-validated here against the SAME
// canonical charting rules used by ordinary block/entry creation:
//   * mode                 -> ELECTROLYSIS_MODES allow-list
//   * area / laterality    -> length + isLaterality + dedup (mirrors normalizeAreaSet)
//   * probe                -> the probe_key is validated against the catalog and the
//                             decomposed columns are DERIVED server-side from it
//                             (browser-submitted decomposition is never trusted)
//   * apilus modality      -> mode-scoped catalog
//   * numeric readings     -> shared ranges (reject invalid rather than NULL-coercing)
//   * mode gating          -> galvanic clears Apilus modality + energy + thermolysis
//                             readings; thermolysis clears galvanic readings; single
//                             pulse clears the delay
//   * primary_area / side  -> DERIVED from the validated areas (deriveLegacyProjection)
//
// minutes_performed is DELIBERATELY NOT part of the input or the output (P1-5):
// this bulk prefill must not write performed minutes into today's live chart.

import {
  ELECTROLYSIS_MODES,
  APILUS_MODALITIES_BY_MODE,
  MACHINE_FREQUENCIES,
  PULSE_COUNT_MIN,
  PULSE_COUNT_MAX,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
} from "@/lib/constants";
import {
  isLaterality,
  deriveLegacyProjection,
  type BlockArea,
} from "@/lib/sessions/block-areas";
import { findProbeOptionByKey } from "@/lib/probes";
import { TREATMENT_AREA_MAX } from "@/lib/sessions/area-validation";

// Reusable machine/probe SETUP fields the practitioner may edit on a card. NO
// minutes_performed and NO decomposed probe columns (those are derived).
export type WholeSessionCopySetupInput = {
  mode: string;
  apilusModality: string;
  energyLevel: string;
  probeKey: string;
  machineFrequency: string;
  thermolysisIntensityPercent: string;
  thermolysisDurationSeconds: string;
  galvanicMa: string;
  galvanicDurationSeconds: string;
  // galvanic_intensity_percent is a RETIRED reading (Phase A): not an input, not
  // normalized, not copied. New destination entries always store NULL.
  unitsOfLye: string;
  pulseCount: string;
  pulseDelay: string;
};

export type WholeSessionCopyDraftInput = {
  areas: { area: string; laterality: string }[];
  customAreaDetail: string | null;
  setup: WholeSessionCopySetupInput;
};

// The validated RPC payload for ONE reviewed draft. Setup + area + entry setup
// readings only — never an outcome, never minutes.
export type WholeSessionCopySpec = {
  block: Record<string, unknown>;
  areas: { area: string; laterality: string; display_order: number }[];
  entry: Record<string, unknown> | null;
};

export type WholeSessionCopyNormalizeResult =
  | { ok: true; specs: WholeSessionCopySpec[] }
  | { ok: false; error: string };

const MODE_VALUES = new Set(ELECTROLYSIS_MODES.map((m) => m.value));
const MACHINE_FREQUENCY_VALUES = new Set<string>(MACHINE_FREQUENCIES);
const CUSTOM_DETAIL_MAX = 60; // matches session_blocks_custom_area_detail_length_check (0039)
const ENERGY_LEVEL_MAX = 100_000; // well above any real dial setting; guards the int4 entry column
const MAX_DRAFTS = 50;
const MAX_AREAS_PER_DRAFT = 25;

// A safe, non-leaky message for any invalid copied value.
const INVALID = "A copied area or setting is invalid. Reload the preview and try again.";

class CopyValidationError extends Error {}

function trimOrNull(s: string | null | undefined, maxLen: number): string | null {
  const t = (s ?? "").trim();
  if (t === "") return null;
  if (t.length > maxLen) throw new CopyValidationError(INVALID);
  return t;
}

// Strict integer in [min,max] (max optional). Blank -> null. Any non-integer or
// out-of-range value throws (never silently coerced to NULL).
function intInRange(s: string, min: number, max?: number): number | null {
  const t = (s ?? "").trim();
  if (t === "") return null;
  if (!/^-?\d+$/.test(t)) throw new CopyValidationError(INVALID);
  const n = Number(t);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new CopyValidationError(INVALID);
  }
  return n;
}

// Strict finite number in [min,max]. Blank -> null. Invalid/out-of-range throws.
function numInRange(s: string, min: number, max?: number): number | null {
  const t = (s ?? "").trim();
  if (t === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new CopyValidationError(INVALID);
  const n = Number(t);
  if (!Number.isFinite(n) || n < min || (max !== undefined && n > max)) {
    throw new CopyValidationError(INVALID);
  }
  return n;
}

function normalizeAreas(
  raw: { area: string; laterality: string }[],
): { area: string; laterality: string; display_order: number }[] {
  if (!Array.isArray(raw) || raw.length > MAX_AREAS_PER_DRAFT) {
    throw new CopyValidationError(INVALID);
  }
  const out: { area: string; laterality: string; display_order: number }[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const area = (r?.area ?? "").trim();
    if (area === "") continue; // blank rows dropped, not an error (mirrors charting)
    if (area.length > TREATMENT_AREA_MAX) throw new CopyValidationError(INVALID);
    const laterality = (r?.laterality ?? "").trim();
    if (!isLaterality(laterality)) throw new CopyValidationError(INVALID);
    const dedupe = `${area.toLowerCase()}|${laterality}`;
    if (seen.has(dedupe)) throw new CopyValidationError(INVALID);
    seen.add(dedupe);
    out.push({ area, laterality, display_order: out.length });
  }
  if (out.length === 0) throw new CopyValidationError(INVALID); // area-less -> no block
  return out;
}

function normalizeDraft(d: WholeSessionCopyDraftInput): WholeSessionCopySpec {
  if (!d || typeof d !== "object" || !d.setup) throw new CopyValidationError(INVALID);
  const s = d.setup;

  const mode = (s.mode ?? "").trim();
  if (!MODE_VALUES.has(mode as "thermo" | "galv" | "blend")) {
    throw new CopyValidationError(INVALID);
  }
  const isGalv = mode === "galv";
  const wantThermo = mode === "thermo" || mode === "blend";
  const wantGalv = mode === "galv" || mode === "blend";

  // Apilus modality: cleared for galvanic; otherwise must be in the mode catalog.
  let apilusModality: string | null = null;
  if (!isGalv) {
    const am = (s.apilusModality ?? "").trim();
    if (am !== "") {
      const allowed = APILUS_MODALITIES_BY_MODE[mode as "thermo" | "blend"] ?? [];
      if (!allowed.includes(am)) throw new CopyValidationError(INVALID);
      apilusModality = am;
    }
  }

  // energy_level: cleared for galvanic; otherwise a non-negative integer within
  // a sane bound (the destination entry column is int4).
  const energyLevel = isGalv ? null : intInRange(s.energyLevel, 0, ENERGY_LEVEL_MAX);

  // Probe: derive the decomposition server-side from the validated key ONLY.
  const probeKey = (s.probeKey ?? "").trim();
  const probe = probeKey ? findProbeOptionByKey(probeKey) : undefined;
  if (probeKey && !probe) throw new CopyValidationError(INVALID);

  // Mode-gated machine readings (reject out-of-range; off-mode forced null).
  const thermInt = wantThermo ? intInRange(s.thermolysisIntensityPercent, 0, 100) : null;
  const thermDur = wantThermo ? numInRange(s.thermolysisDurationSeconds, 0) : null;
  const galvMa = wantGalv ? numInRange(s.galvanicMa, 0) : null;
  const galvDur = wantGalv ? intInRange(s.galvanicDurationSeconds, 0) : null;
  // galvanic_intensity_percent is RETIRED (Phase A): never parsed from the draft
  // and never emitted into the spec, so a forged card value can't influence the
  // destination. The RPC additionally inserts a literal NULL (defense in depth).
  const unitsOfLye = wantGalv ? numInRange(s.unitsOfLye, 0) : null;

  const pulseCount = intInRange(s.pulseCount, PULSE_COUNT_MIN, PULSE_COUNT_MAX);
  const pulseDelay =
    pulseCount != null && pulseCount > 1
      ? numInRange(s.pulseDelay, PULSE_DELAY_MIN, PULSE_DELAY_MAX)
      : null;

  // Machine frequency: canonical allowlist (blank clears; anything else rejects).
  const mfRaw = (s.machineFrequency ?? "").trim();
  const machineFrequency = mfRaw === "" ? null : mfRaw;
  if (machineFrequency !== null && !MACHINE_FREQUENCY_VALUES.has(machineFrequency)) {
    throw new CopyValidationError(INVALID);
  }
  const customAreaDetail = trimOrNull(d.customAreaDetail, CUSTOM_DETAIL_MAX);

  // Areas + server-derived primary_area/side (never trust browser primary/side).
  const areas = normalizeAreas(d.areas);
  const projection = deriveLegacyProjection(
    areas.map((a) => ({ area: a.area, laterality: a.laterality }) as BlockArea),
  );

  const block: Record<string, unknown> = {
    mode,
    apilus_modality: apilusModality,
    energy_level: energyLevel,
    machine_frequency: machineFrequency,
    probe_key: probe ? probe.key : null,
    probe_brand: probe ? probe.brand : null,
    probe_material: probe ? probe.material : null,
    probe_piece_type: probe ? probe.pieceType : null,
    probe_shank: probe ? probe.shank : null,
    probe_size_value: probe ? probe.size : null,
    probe_length: probe ? probe.length : null,
    probe_label: probe ? probe.displayLabel : null,
    primary_area: projection.primaryArea,
    side: projection.side,
    custom_area_detail: customAreaDetail,
  };

  const primaryAreaName = areas[0].area;
  const entry: Record<string, unknown> = {
    area: primaryAreaName,
    areas: areas.map((a) => a.area),
    mode,
    apilus_modality: apilusModality,
    energy_level: energyLevel,
    machine_frequency: machineFrequency,
    thermolysis_intensity_percent: thermInt,
    thermolysis_duration_seconds: thermDur,
    galvanic_ma: galvMa,
    galvanic_duration_seconds: galvDur,
    // galvanic_intensity_percent is deliberately ABSENT from the spec (retired).
    // The RPC forces a literal NULL on insert regardless of the spec.
    units_of_lye: unitsOfLye,
    pulse_count: pulseCount,
    pulse_delay_seconds: pulseDelay,
  };

  return { block, areas, entry };
}

// Normalize + validate the whole reviewed batch. Returns the SQL specs on
// success, or a single safe error message on the first invalid value.
export function normalizeWholeSessionCopy(
  drafts: readonly WholeSessionCopyDraftInput[],
): WholeSessionCopyNormalizeResult {
  try {
    if (!Array.isArray(drafts) || drafts.length === 0) {
      return { ok: false, error: "There is nothing to copy. Reload the preview and try again." };
    }
    if (drafts.length > MAX_DRAFTS) {
      return { ok: false, error: INVALID };
    }
    const specs = drafts.map(normalizeDraft);
    return { ok: true, specs };
  } catch (e) {
    if (e instanceof CopyValidationError) return { ok: false, error: e.message };
    return { ok: false, error: INVALID };
  }
}

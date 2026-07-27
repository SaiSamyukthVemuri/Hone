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
import { legacySideToLaterality } from "./block-areas";
import { ELECTROLYSIS_MODES } from "@/lib/constants";
import type { WholeSessionCopyDraftInput } from "./whole-session-copy-normalize";

const COPYABLE_MODES = new Set(ELECTROLYSIS_MODES.map((m) => m.value));

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

// Build the ephemeral preview from the previous session's blocks. Only blocks
// that are actually COPYABLE become cards, so one un-copyable source block can
// never poison the whole batch at commit:
//   * a legacy block with a primary_area but no structured areas gets a
//     synthesized area (primary_area + the laterality of its legacy side), so it
//     copies like any other;
//   * a block with no resolvable area, or no valid electrolysis mode, has no
//     reusable setup to copy and is skipped.
// Pure — no I/O.
export function buildCopyDrafts(
  source: readonly CopySourceBlock[],
): CopyAreaDraft[] {
  const drafts: CopyAreaDraft[] = [];
  for (let i = 0; i < source.length; i++) {
    const b = source[i];
    let areas = b.areas.map((a) => ({ area: a.area, laterality: a.laterality }));
    if (areas.length === 0 && (b.primary_area ?? "").trim() !== "") {
      // Legacy single-area block: reconstruct a structured area so it copies.
      areas = [{ area: b.primary_area!.trim(), laterality: legacySideToLaterality(b.side) }];
    }
    if (areas.length === 0) continue; // nothing to copy
    const setup = buildTreatmentSetupDraftPatch(
      b.block,
      firstLiveEntry(b.firstEntry ? [b.firstEntry] : []),
    );
    if (!COPYABLE_MODES.has(setup.mode as "thermo" | "galv" | "blend")) continue; // no reusable setup
    drafts.push({
      key: b.blockId || String(i),
      primaryArea: b.primary_area,
      side: b.side,
      customAreaDetail: b.custom_area_detail,
      areas,
      setup,
      probe: b.probe,
    });
  }
  return drafts;
}

// Turn a reviewed (possibly edited) draft card into the NARROW input the server
// normalizer validates. This carries ONLY editable areas + machine/probe setup
// strings — never the decomposed probe columns (the server re-derives those from
// the probe_key), never minutes_performed (not copied), and never an outcome.
// All authority (probe decomposition, primary_area/side, numeric ranges, mode
// gating) lives server-side in normalizeWholeSessionCopy.
export function draftToCopyInput(d: CopyAreaDraft): WholeSessionCopyDraftInput {
  const s = d.setup;
  return {
    areas: d.areas
      .filter((a) => (a.area ?? "").trim() !== "")
      .map((a) => ({ area: a.area, laterality: a.laterality })),
    customAreaDetail: d.customAreaDetail,
    setup: {
      mode: s.mode,
      apilusModality: s.apilusModality,
      energyLevel: s.energyLevel,
      probeKey: s.probeKey,
      machineFrequency: s.machineFrequency,
      thermolysisIntensityPercent: s.thermolysisIntensityPercent,
      thermolysisDurationSeconds: s.thermolysisDurationSeconds,
      galvanicMa: s.galvanicMa,
      galvanicDurationSeconds: s.galvanicDurationSeconds,
      // galvanic_intensity_percent is a RETIRED reading (Phase A): never copied.
      unitsOfLye: s.unitsOfLye,
      pulseCount: s.pulseCount,
      pulseDelay: s.pulseDelay,
    },
  };
}

// Shared, pure UI mode-gating for electrolysis charting. A single source of
// truth for which setting sections apply to a mode, used by BOTH the block
// charting form and the whole-session copy editor so they can never drift.
// (The DATA-layer gating — clearing off-mode values to null — lives in
// buildTreatmentSetupDraftPatch and normalizeWholeSessionCopy; this only decides
// what the UI shows.)

export type ModeSections = {
  showModality: boolean; // Apilus modality applies (thermo/blend, never galvanic)
  showThermo: boolean; // thermolysis readings apply (thermo/blend)
  showGalv: boolean; // galvanic readings apply (galv/blend)
};

export function resolveModeSections(mode: string | null | undefined): ModeSections {
  const m = (mode ?? "").trim();
  return {
    showModality: m === "thermo" || m === "blend",
    showThermo: m === "thermo" || m === "blend",
    showGalv: m === "galv" || m === "blend",
  };
}

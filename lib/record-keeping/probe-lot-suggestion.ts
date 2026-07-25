import { findProbeOptionByKey } from "@/lib/probes";

// Pure, client-safe probe-lot suggestion helpers (no server-only, no DB). Both
// the server query (lib/record-keeping/queries.ts) and the client charting form
// (block-setup-form.tsx) import from here, so the shared types + matching logic
// live in one place and stay unit-testable without a database.

export type ProbeLotSuggestion = {
  lot: string;
  confirmed: boolean;
  // Migration 0155: the linked inventory item id of the DISPLAY-winning prior
  // selection (the confirmed-then-newest row of ANY source). Null when that
  // winning row was manual/free-text — which is exactly why it must NOT drive
  // auto-fill on its own (a newer confirmed MANUAL row would otherwise mask an
  // older confirmed LINKED one). Kept for display/debugging only.
  inventoryItemId: string | null;
  // Migration 0155 (last-confirmed-LINKED): the newest row satisfying BOTH
  // probe_lot_confirmed = true AND probe_inventory_item_id IS NOT NULL, tracked
  // INDEPENDENTLY of the display winner. This is the ONLY value the charting
  // auto-fill uses to re-fill the practitioner's last inventory lot (and only
  // when it is still active + matches the selected probe). Null when no prior
  // confirmed LINKED selection exists (e.g. only confirmed manual rows, or only
  // unconfirmed linked rows).
  lastConfirmedInventoryItemId: string | null;
};

export type ProbeLotSuggestions = {
  // Keyed by session_blocks.probe_key.
  byKey: Record<string, ProbeLotSuggestion>;
  // Keyed by normalizeProbeLabel(probe_label) — the safe free-text fallback
  // (covers rows with a null probe_key, and lets a catalog selection match a
  // prior free-text entry with the same label).
  byLabel: Record<string, ProbeLotSuggestion>;
};

// Case/whitespace-insensitive label key, e.g.
// "Sterex · Gold · Two-piece · F2 Short".
export function normalizeProbeLabel(label: string | null | undefined): string {
  return (label ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Resolve the lot suggestion for the selected probe: keyed match first, then a
// normalized-display-label fallback (covers a prior free-text entry — probe_key
// null — with the SAME label). Keyed match always beats the label fallback.
export function resolveProbeLotSuggestion(
  probeKey: string,
  suggestions: ProbeLotSuggestions,
): ProbeLotSuggestion | null {
  if (!probeKey) return null;
  const keyed = suggestions.byKey[probeKey];
  if (keyed) return keyed;
  const opt = findProbeOptionByKey(probeKey);
  if (opt) {
    const labeled = suggestions.byLabel[normalizeProbeLabel(opt.displayLabel)];
    if (labeled) return labeled;
  }
  return null;
}

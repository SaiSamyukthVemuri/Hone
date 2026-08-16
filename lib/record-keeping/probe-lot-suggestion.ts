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
  // winning row was manual/free-text, which is exactly why it must NOT drive
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
  // The most recently CHARTED lot for this probe, by created_at alone,
  // confirmation is deliberately ignored. This is the only field the charting
  // auto-fill history fallback may use: "what lot am I using right now" is a
  // question about RECENCY, and `lot` above is confirmed-first, so a single old
  // confirmed row would otherwise pin the field forever (auto-fill never
  // confirms, so every later row stays unconfirmed).
  lastCharted: string;
  // Migration 0182: the inventory item id of the SAME row `lastCharted` came
  // from (null when that row was manual/free-text). Tracked purely so the
  // history fallback can check that item's LIFECYCLE BY IDENTITY.
  //
  // Identity is required because the alternatives are both wrong. Matching on
  // the row's CURRENT probe classification misses an item that was charted
  // under one probe and later reclassified to another — reclassifying a box
  // does not put it back on the shelf. Matching on the lot NUMBER across all
  // inventory over-fires, because lot numbers are explicitly not unique and a
  // different probe's same-numbered lot must never block this probe's history
  // (pinned by "an expired lot for ANOTHER probe never blocks this probe's
  // history"). The id is the only thing that identifies the physical item.
  lastChartedInventoryItemId: string | null;
  // Migration 0182: the lifecycle verdict for THAT EXACT item, resolved by a
  // dedicated identity-complete studio-scoped read (getInventoryLifecycleByIds)
  // — deliberately NOT by looking the id up in the charting picker's inventory.
  //
  // The picker list is a FILTERED, BOUNDED projection: it requires a non-null
  // probe_key, drops blank lot numbers during option construction, and is
  // capped. A historically linked row can therefore be legitimately absent from
  // it while still existing and still being discarded. Resolving lifecycle
  // against that list made absence indistinguishable from "not inventory", so
  // the guard failed OPEN and auto-filled discarded stock as free text.
  //
  // null = the charted row carried NO inventory id (manual/free-text): there is
  // no item and therefore no lifecycle to check. That is not the same as
  // "unknown", and must not be treated as a reason to block.
  lastChartedLifecycle: ChartedLifecycleStatus | null;
};

// The lifecycle verdict for one exact, historically linked inventory item.
//
//   "current"     -> resolved, and neither discarded nor expired
//   "not-current" -> resolved, and discarded and/or expired
//   "unknown"     -> an id exists but its lifecycle could NOT be established
//                    (row not found — deleted, cross-studio, or otherwise
//                    invisible — or the authority read failed)
//
// "unknown" is a first-class state on purpose. Collapsing it into "current"
// is exactly the bug this type exists to prevent: for CURRENT-work auto-fill,
// "I could not determine whether this stock still exists" must fail CLOSED.
export type ChartedLifecycleStatus = "current" | "not-current" | "unknown";

// Pure classification of one item's lifecycle facts. `fact` is undefined/null
// when the identity read returned no row for that id, which is "unknown", never
// "current". Discard is presence-based (the practitioner asserted the stock is
// gone; it does not come back when the calendar rolls over); expiry is a date
// comparison, matching buildProbeLotOptions.
export function chartedLifecycleStatus(
  fact:
    | { expiryDate: string | null; dateDiscarded: string | null }
    | null
    | undefined,
  todayIso: string,
): ChartedLifecycleStatus {
  if (!fact) return "unknown";
  if (fact.dateDiscarded != null) return "not-current";
  if (fact.expiryDate != null && fact.expiryDate < todayIso) return "not-current";
  return "current";
}

export type ProbeLotSuggestions = {
  // Keyed by session_blocks.probe_key.
  byKey: Record<string, ProbeLotSuggestion>;
  // Keyed by normalizeProbeLabel(probe_label), the safe free-text fallback
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
// normalized-display-label fallback (covers a prior free-text entry: probe_key
// null: with the SAME label). Keyed match always beats the label fallback.
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

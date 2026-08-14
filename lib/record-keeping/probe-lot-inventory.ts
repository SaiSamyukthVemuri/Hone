// Inventory-backed probe-lot selection logic (Chloe item #9, migration 0155).
//
// SOURCE OF TRUTH: record_keeping_sterile_items — the studio's actively
// maintained sterile-inventory log. From 0155 a sterile item may carry a
// structured probe_key (lib/probes.ts catalog), so probe lots are now selected
// PROBE-SPECIFICALLY from real inventory rows, each carrying its immutable
// inventory id. The legacy `probe_lots` table + electrolysis_entries.probe_lot_id
// remain DORMANT and are deliberately NOT used here.
//
// This module is pure + client-safe. The server query (queries.ts) shapes rows
// into ProbeLotInventoryRow[]; the charting form uses these helpers to render a
// searchable ACTIVE-lot chooser while ALWAYS keeping manual entry available and
// preserving the saved lot-number snapshot on session_blocks.probe_lot_number.
//
// Identity is the inventory row `id`, NEVER the lot number: two different
// inventory records may share a lot number (no DB uniqueness) yet differ by
// probe / manufacturer / description / expiry — they stay DISTINCT options.
//
// "Active" = not past its expiry date (a null expiry never expires). Expired
// lots are still SELECTABLE for truthful retrospective charting, but never sort
// first and are never auto-filled.

export type ProbeLotInventoryRow = {
  id: string;
  probeKey: string | null;
  lotNumber: string;
  itemDescription: string;
  manufacturerName: string | null;
  // ISO "YYYY-MM-DD" or null (null = never expires).
  expiryDate: string | null;
};

export type ProbeLotOption = {
  id: string;
  probeKey: string | null;
  lotNumber: string;
  itemDescription: string;
  manufacturerName: string | null;
  expiryDate: string | null;
  isExpired: boolean;
};

// null expiry (never expires) is the "most current"; between two dated lots the
// later expiry is more current. Returns <0 when a should sort before b.
function compareExpiryDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? 1 : -1;
}

// Shape raw probe sterile-item rows into classified, ordered options — ONE
// option per inventory row (NO dedupe by lot number). Active options sort first,
// then later expiry, then lot number, then id (stable). Rows with a blank lot
// number are dropped (a lot with no number cannot be a durable selection).
export function buildProbeLotOptions(
  rows: ReadonlyArray<ProbeLotInventoryRow>,
  todayIso: string,
): ProbeLotOption[] {
  const options: ProbeLotOption[] = [];
  for (const r of rows) {
    const lot = (r.lotNumber ?? "").trim();
    if (!lot) continue;
    options.push({
      id: r.id,
      probeKey: r.probeKey,
      lotNumber: lot,
      itemDescription: (r.itemDescription ?? "").trim(),
      manufacturerName: (r.manufacturerName ?? "").trim() || null,
      expiryDate: r.expiryDate,
      isExpired: r.expiryDate != null && r.expiryDate < todayIso,
    });
  }
  return options.sort((a, b) => {
    if (a.isExpired !== b.isExpired) return a.isExpired ? 1 : -1; // active first
    const e = compareExpiryDesc(a.expiryDate, b.expiryDate);
    if (e !== 0) return e;
    const l = a.lotNumber.localeCompare(b.lotNumber);
    return l !== 0 ? l : a.id.localeCompare(b.id);
  });
}

// Only the non-expired options for a specific probe (the default chooser set
// after a probe is selected). probeKey must match exactly; a null probeKey on an
// option (unclassified inventory) never matches a chosen probe.
export function activeProbeLotOptionsForProbe(
  options: ReadonlyArray<ProbeLotOption>,
  probeKey: string | null | undefined,
): ProbeLotOption[] {
  const key = (probeKey ?? "").trim();
  if (!key) return [];
  return options.filter((o) => !o.isExpired && o.probeKey === key);
}

// All (active + expired) options for a specific probe — used when EDITING a
// historical linked record so an expired linked lot stays visible.
export function probeLotOptionsForProbe(
  options: ReadonlyArray<ProbeLotOption>,
  probeKey: string | null | undefined,
): ProbeLotOption[] {
  const key = (probeKey ?? "").trim();
  if (!key) return [];
  return options.filter((o) => o.probeKey === key);
}

// Search across lot number, description, and manufacturer (case-insensitive).
// An empty query returns everything unchanged (no reordering).
export function filterProbeLotOptions(
  options: ReadonlyArray<ProbeLotOption>,
  query: string,
): ProbeLotOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter(
    (o) =>
      o.lotNumber.toLowerCase().includes(q) ||
      o.itemDescription.toLowerCase().includes(q) ||
      (o.manufacturerName ?? "").toLowerCase().includes(q),
  );
}

export type ProbeLotAutofill =
  | { kind: "last-confirmed"; option: ProbeLotOption }
  | { kind: "only-active"; option: ProbeLotOption }
  | { kind: "choose" };

// Inventory-backed auto-fill for a probe (Chloe item #9 AUTO-FILL RULES). Only
// ACTIVE inventory rows for THIS probe_key are considered. Never auto-fills an
// expired lot; never chooses arbitrarily among multiple active lots. Every
// auto-fill is UNCONFIRMED (the caller resets confirmation).
//   1. If the last confirmed prior selection references one of these exact
//      active inventory ids → auto-fill that item ("last-confirmed").
//   2. Else if EXACTLY ONE active matching item exists → auto-fill it ("only-active").
//   3. Otherwise → "choose" (empty; show the matching chooser).
// A previous free-text lot that does not resolve to an active matching inventory
// id is NOT passed here (the caller passes only a prior *inventory item id*), so
// it can never be silently auto-filled as inventory-backed.
export function resolveInventoryAutofill(
  options: ReadonlyArray<ProbeLotOption>,
  probeKey: string | null | undefined,
  lastConfirmedInventoryItemId: string | null | undefined,
): ProbeLotAutofill {
  const active = activeProbeLotOptionsForProbe(options, probeKey);
  const lastId = (lastConfirmedInventoryItemId ?? "").trim();
  if (lastId) {
    const match = active.find((o) => o.id === lastId);
    if (match) return { kind: "last-confirmed", option: match };
  }
  if (active.length === 1) return { kind: "only-active", option: active[0] };
  return { kind: "choose" };
}

// A one-line label for an option, e.g.
//   "460941: Sterex Gold F3 · expires 2026-12-01"
//   "460941: Sterex Gold F3 · no expiry"
//   "460941: Sterex Gold F3 · EXPIRED 2025-01-01"
//
// The lot-number prefix delimiter is a CONTRACT with probe-lot-select.tsx,
// which strips it to show the description alone beside the lot number it
// already renders. Producer and consumer must change together; see
// tests/lib/record-keeping/probe-lot-inventory.test.ts for the pin.
export const PROBE_LOT_LABEL_DELIMITER = ": ";
export function probeLotOptionLabel(o: ProbeLotOption): string {
  const head = o.itemDescription
    ? `${o.lotNumber}${PROBE_LOT_LABEL_DELIMITER}${o.itemDescription}`
    : o.lotNumber;
  const status = o.expiryDate
    ? o.isExpired
      ? `EXPIRED ${o.expiryDate}`
      : `expires ${o.expiryDate}`
    : "no expiry";
  return `${head} · ${status}`;
}

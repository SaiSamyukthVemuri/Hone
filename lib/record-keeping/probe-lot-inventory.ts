// Inventory-backed probe-lot selection logic (Chloe item #9, migration 0155).
//
// SOURCE OF TRUTH: record_keeping_sterile_items, the studio's actively
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
// probe / manufacturer / description / expiry: they stay DISTINCT options.
//
// "Active" = not past its expiry date (a null expiry never expires). Expired
// lots are still SELECTABLE for truthful retrospective charting, but never sort
// first and are never auto-filled.
//
// Migration 0182 adds a SECOND, INDEPENDENT reason a lot is not current stock:
// the practitioner recorded a structured discard (date_discarded). Expiry is a
// property of the package; discard is an assertion about the PHYSICAL stock
// ("I threw this away"). They are orthogonal — an unexpired box can be
// discarded, and an expired box can still be sitting on the shelf unlogged — so
// they are carried as two flags and never collapsed into one.
//
// CRITICAL ARCHITECTURE RULE. Discarded rows are NOT removed here, exactly as
// expired rows are not removed here. `buildProbeLotOptions` is the FOUNDATIONAL
// read: a historical session's inventory link must still resolve through it
// after the stock is discarded, or traceability and retrospective editing break.
// The discard is carried on the option as `isDiscarded` and gated ONLY at the
// CURRENT-stock boundary (`activeProbeLotOptionsForProbe` / auto-fill). Current
// inventory is not historical record existence.

export type ProbeLotInventoryRow = {
  id: string;
  probeKey: string | null;
  lotNumber: string;
  itemDescription: string;
  manufacturerName: string | null;
  // ISO "YYYY-MM-DD" or null (null = never expires).
  expiryDate: string | null;
  // Migration 0182: ISO "YYYY-MM-DD" or null (null = not discarded).
  dateDiscarded: string | null;
};

export type ProbeLotOption = {
  id: string;
  probeKey: string | null;
  lotNumber: string;
  itemDescription: string;
  manufacturerName: string | null;
  expiryDate: string | null;
  isExpired: boolean;
  // Migration 0182: the practitioner recorded this physical stock as discarded.
  dateDiscarded: string | null;
  isDiscarded: boolean;
};

// The single definition of "usable as CURRENT stock", so the server selectors
// and the client chooser cannot drift apart. An option is current stock when it
// is neither expired nor discarded. Every "offer this for NEW work" surface
// must go through this predicate; no historical surface may.
export function isCurrentStock(option: ProbeLotOption): boolean {
  return !option.isExpired && !option.isDiscarded;
}

// null expiry (never expires) is the "most current"; between two dated lots the
// later expiry is more current. Returns <0 when a should sort before b.
function compareExpiryDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? 1 : -1;
}

// Shape raw probe sterile-item rows into classified, ordered options, ONE
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
      dateDiscarded: r.dateDiscarded,
      // Migration 0182. Presence of the date IS the assertion; the date itself
      // is never compared against today. A discard recorded with a future or
      // back-dated date is still a discard — the practitioner said the stock is
      // gone, and stock does not un-vanish when the calendar rolls over. (This
      // is the deliberate difference from expiry, which IS a date comparison.)
      isDiscarded: r.dateDiscarded != null,
    });
  }
  return options.sort((a, b) => {
    // Current stock first. Discarded sorts with expired: both are "not usable
    // now", so neither may sit at the top of a chooser.
    const aCurrent = isCurrentStock(a);
    const bCurrent = isCurrentStock(b);
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const e = compareExpiryDesc(a.expiryDate, b.expiryDate);
    if (e !== 0) return e;
    const l = a.lotNumber.localeCompare(b.lotNumber);
    return l !== 0 ? l : a.id.localeCompare(b.id);
  });
}

// Only the CURRENT-stock options for a specific probe (the default chooser set
// after a probe is selected). probeKey must match exactly; a null probeKey on an
// option (unclassified inventory) never matches a chosen probe.
//
// This is the CURRENT-inventory boundary. Migration 0182: a discarded lot is
// excluded here — the physical stock is gone, so it is not usable now — exactly
// as an expired lot is excluded. It remains present in the full list below.
export function activeProbeLotOptionsForProbe(
  options: ReadonlyArray<ProbeLotOption>,
  probeKey: string | null | undefined,
): ProbeLotOption[] {
  const key = (probeKey ?? "").trim();
  if (!key) return [];
  return options.filter((o) => isCurrentStock(o) && o.probeKey === key);
}

// All (current + expired + discarded) options for a specific probe: used when
// EDITING a historical linked record so an expired or since-discarded linked lot
// stays visible. HISTORICAL surface — it must never gate on lifecycle state.
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
// CURRENT-STOCK inventory rows for THIS probe_key are considered, so migration
// 0182's discard gate applies here for free: a discarded lot is absent from
// `active`, which means rule 1 cannot match it even when it IS the last
// confirmed selection, and it can never be the sole "only-active" pick. Never
// auto-fills an expired or discarded lot; never chooses arbitrarily among
// multiple current lots. Every
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
//   "460941: Sterex Gold F3 · DISCARDED 2026-07-10"   (0182)
//
// Migration 0182: a discard is the stronger statement — an expired box may
// still be on the shelf, but a discarded one is gone — so when both apply the
// label reports the discard. The expiry is still on the option for any caller
// that needs it.
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
  const status = o.isDiscarded
    ? `DISCARDED ${o.dateDiscarded}`
    : o.expiryDate
      ? o.isExpired
        ? `EXPIRED ${o.expiryDate}`
        : `expires ${o.expiryDate}`
      : "no expiry";
  return `${head} · ${status}`;
}

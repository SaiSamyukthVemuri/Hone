// Active probe-lot inventory selection logic (migration 0128 charting release).
//
// SOURCE OF TRUTH: record_keeping_sterile_items — the studio's actively
// maintained sterilization/inventory log — filtered to rows whose description
// mentions a probe. The legacy `probe_lots` table is DORMANT (no writers, no
// callers) and is deliberately NOT used here.
//
// This module is pure + client-safe (no DB, no server-only). The server query
// (lib/record-keeping/queries.ts) shapes raw rows into ProbeLotInventoryRow[];
// the charting form (block-setup-form.tsx) uses these helpers to render a
// searchable ACTIVE-lot selector while ALWAYS keeping manual entry available and
// preserving the saved lot-number snapshot on session_blocks.probe_lot_number.
//
// "Active" = not past its expiry date (record_keeping_sterile_items has no
// is_active/archived flag; an item with a null expiry never expires). Expired
// lots are still SELECTABLE (a historical value must remain visible/usable), but
// they never sort first and are never auto-suggested.

export type ProbeLotInventoryRow = {
  lotNumber: string;
  itemDescription: string;
  manufacturerName: string | null;
  // ISO "YYYY-MM-DD" or null (null = never expires).
  expiryDate: string | null;
};

export type ProbeLotOption = {
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

// Shape raw probe sterile-item rows into deduped, classified, ordered options.
// Dedupe by case-insensitive lot number, preferring a NON-expired representative
// (else the one with the later expiry). Active options sort first.
export function buildProbeLotOptions(
  rows: ReadonlyArray<ProbeLotInventoryRow>,
  todayIso: string,
): ProbeLotOption[] {
  const byLot = new Map<string, ProbeLotOption>();
  for (const r of rows) {
    const lot = (r.lotNumber ?? "").trim();
    if (!lot) continue;
    const cand: ProbeLotOption = {
      lotNumber: lot,
      itemDescription: (r.itemDescription ?? "").trim(),
      manufacturerName: (r.manufacturerName ?? "").trim() || null,
      expiryDate: r.expiryDate,
      isExpired: r.expiryDate != null && r.expiryDate < todayIso,
    };
    const key = lot.toLowerCase();
    const existing = byLot.get(key);
    if (!existing) {
      byLot.set(key, cand);
      continue;
    }
    if (existing.isExpired && !cand.isExpired) {
      byLot.set(key, cand);
      continue;
    }
    if (existing.isExpired === cand.isExpired) {
      byLot.set(
        key,
        compareExpiryDesc(cand.expiryDate, existing.expiryDate) < 0
          ? cand
          : existing,
      );
    }
  }
  return [...byLot.values()].sort((a, b) => {
    if (a.isExpired !== b.isExpired) return a.isExpired ? 1 : -1;
    const e = compareExpiryDesc(a.expiryDate, b.expiryDate);
    if (e !== 0) return e;
    return a.lotNumber.localeCompare(b.lotNumber);
  });
}

// Only the non-expired options (the default selectable set).
export function activeProbeLotOptions(
  options: ReadonlyArray<ProbeLotOption>,
): ProbeLotOption[] {
  return options.filter((o) => !o.isExpired);
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

// The single ACTIVE lot to SUGGEST (never auto-select), or null.
//   * A last-used lot (a prior charting snapshot) that matches an ACTIVE option
//     wins — the practitioner's own recent choice.
//   * Otherwise suggest ONLY when there is EXACTLY ONE active option.
//   * With multiple active options and no last-used match → null (never silently
//     pick one).
export function suggestProbeLot(
  options: ReadonlyArray<ProbeLotOption>,
  lastUsedLot: string | null | undefined,
): ProbeLotOption | null {
  const active = activeProbeLotOptions(options);
  const last = (lastUsedLot ?? "").trim().toLowerCase();
  if (last) {
    const match = active.find((o) => o.lotNumber.toLowerCase() === last);
    if (match) return match;
  }
  return active.length === 1 ? active[0] : null;
}

// A one-line label for an option, e.g.
//   "460941 — Sterex Gold F3 · expires 2026-12-01"
//   "460941 — Sterex Gold F3 · no expiry"
//   "460941 — Sterex Gold F3 · EXPIRED 2025-01-01"
export function probeLotOptionLabel(o: ProbeLotOption): string {
  const head = o.itemDescription
    ? `${o.lotNumber} — ${o.itemDescription}`
    : o.lotNumber;
  const status = o.expiryDate
    ? o.isExpired
      ? `EXPIRED ${o.expiryDate}`
      : `expires ${o.expiryDate}`
    : "no expiry";
  return `${head} · ${status}`;
}

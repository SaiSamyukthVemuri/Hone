// Global Search — treatment-memory candidate merge (pure).
//
// A treatment-memory block becomes findable down TWO independent paths:
//
//   DIRECT — the block's own text columns match (primary_area, block_name,
//            caution_note, reaction_notes, probe_label, probe_lot_number).
//
//   CHILD  — one of the block's STRUCTURED treatment areas matches
//            (session_block_areas.area). This is the only way a SECONDARY area
//            is reachable: a block charted as "Left Cheek · Right Sideburn"
//            carries the legacy primary_area "Cheek", so searching "Sideburn"
//            found nothing at all even though the result, once found, displayed
//            the sideburn perfectly well. That was a RECALL gap, not a display
//            gap, and this module is the half that closes it.
//
// The two paths deliberately OVERLAP — a query like "Cheek" matches both the
// legacy primary_area and the structured child row for the very same block — so
// merging is what keeps one treatment showing up as one result.
//
// PURE: no I/O, no server-only import, no Supabase client. The caller supplies
// rows it has already fetched (bounded, studio-scoped) and this module decides
// identity, order and cap. Keeping that decision here rather than inline in the
// server action is what makes it testable in isolation.
//
// This module owns NO display logic. `blockAreasLabel` remains the single
// authority for how a treated-area set is rendered.

// The minimum shape the merge needs. Callers pass their own richer row type
// through unchanged (the generic is preserved end to end), so nothing here has
// to know about sessions, clients, probes or areas.
export type MergeableBlockRow = {
  id: string;
  // PostgREST hands back an ISO string, but a row read through node-postgres
  // arrives with a real Date. Both are accepted: a caller whose driver returns
  // Dates would otherwise have every row silently rank as undated, and the
  // newest-first order would collapse into the id tiebreak without failing.
  created_at?: string | Date | number | null;
};

// Rows arrive from Supabase as loosely-typed records; a malformed one (null, a
// non-object, or an id that is not a usable string) is DROPPED rather than
// allowed to become a result with a broken href or a duplicate-collapsing empty
// key. Failing safe here keeps one bad row from poisoning the whole result set.
function usableId(row: unknown): string | null {
  if (row == null || typeof row !== "object") return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

// Newest-first is the existing clinical-memory order (session_blocks ordered by
// created_at descending). An unparseable or absent timestamp sorts LAST rather
// than throwing or being treated as "now" — an undated row must never displace a
// dated one at the top of a practitioner's results.
function createdAtRank(row: MergeableBlockRow): number {
  const raw = row.created_at;
  if (raw == null || raw === "") return Number.NEGATIVE_INFINITY;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? Number.NEGATIVE_INFINITY : raw.getTime();
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY;
  }
  if (typeof raw !== "string") return Number.NEGATIVE_INFINITY;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

// How much of the row is actually populated. When the same block arrives down
// both paths the two selects are identical today, so this is a tie in practice —
// but if a future caller ever fetches a narrower shape on one path, the merge
// keeps the row that can actually render a subtitle instead of silently keeping
// whichever path happened to be listed first.
function populatedFieldCount(row: MergeableBlockRow): number {
  let n = 0;
  for (const value of Object.values(row as Record<string, unknown>)) {
    if (value !== null && value !== undefined) n += 1;
  }
  return n;
}

/**
 * Merge the direct and child-area candidate sets into the final, ordered,
 * capped treatment-memory block list.
 *
 * Guarantees, each pinned by a test:
 *   * deduplicated by block id — one treatment is one result, however many
 *     paths or matching child areas found it;
 *   * the RICHEST row survives a duplicate (ties keep the direct-path row, so
 *     the order of the arguments is the documented tiebreak, not an accident);
 *   * ordered newest-first by created_at, with id ascending as a STABLE
 *     tiebreak so equal timestamps never reorder between calls;
 *   * the cap is applied AFTER deduplication, so a block found down both paths
 *     can never consume two of the available slots and hide a distinct result;
 *   * malformed rows are dropped, never thrown on.
 */
export function mergeMemoryBlockRows<T extends MergeableBlockRow>(
  direct: readonly T[] | null | undefined,
  childMatched: readonly T[] | null | undefined,
  cap: number,
): T[] {
  const byId = new Map<string, T>();

  // Direct first so it is the incumbent on a richness tie.
  for (const source of [direct ?? [], childMatched ?? []]) {
    for (const row of source) {
      const id = usableId(row);
      if (id == null) continue;
      const existing = byId.get(id);
      if (existing == null) {
        byId.set(id, row);
        continue;
      }
      // Strictly richer replaces; equal richness keeps the incumbent.
      if (populatedFieldCount(row) > populatedFieldCount(existing)) {
        byId.set(id, row);
      }
    }
  }

  const merged = [...byId.values()].sort((a, b) => {
    const rankA = createdAtRank(a);
    const rankB = createdAtRank(b);
    // Compared, never subtracted: two undated rows both rank -Infinity, and
    // -Infinity - -Infinity is NaN, which would make the comparator inconsistent
    // and silently destroy the id tiebreak below.
    if (rankA !== rankB) return rankB > rankA ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // A non-positive or non-finite cap yields nothing rather than everything: a
  // cap that fails open is not a cap.
  if (!Number.isFinite(cap) || cap <= 0) return [];
  return merged.slice(0, Math.floor(cap));
}

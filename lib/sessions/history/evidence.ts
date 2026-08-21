// IS THIS VISIT CHARTED? — answered from the session row, never from a
// collection a row cap can silently empty.
//
// THE MOVE THIS FILE MAKES
// ------------------------
// In production, "does this session contain charting?" is decided by
// `hasChartedContent` looking for a live row in a `session_blocks` map fetched
// for every candidate at once with `.in("session_id", …)`. That read is the
// origin of the whole defect family:
//
//   * it is ordered by `sort_order`, an INTRA-session display key assigned as
//     max(sort_order)+1 over live rows, so ordering by it ACROSS sessions
//     interleaves every session's block #1, then every #2, and the cut lands
//     wherever it lands. On the live database `sort_order = 1` is shared by 180
//     distinct sessions;
//   * it carries no `.limit()`, so its real bound is PostgREST's invisible
//     `max_rows` and truncation is undetectable at the call site;
//   * a session whose rows fell past the cut has NO entry in the map, and
//     `blocksBySession.get(id) ?? []` renders that as "zero live blocks", i.e.
//     as NOT CHARTED — which is how an older visit came to be presented as the
//     last treatment, and how a returning client came to be called new.
//
// A COUNT cannot be truncated. PostgREST supports a per-parent aggregate over an
// embedded relation with the child filter applied, so charted-ness stops being
// an inference over a cappable collection and becomes a SCALAR on an
// authoritative row.
//
// NOTE ON THE PROJECTION LAW. The string below is an AGGREGATE selection, not a
// clinical-entry projection: it names no clinical column and returns no clinical
// value. The one canonical full-detail clinical projection lives in
// lib/sessions/history/visit-detail.ts, and adding a treatment field there
// requires no change here.
//
// Pure. No I/O. Client-safe.

/**
 * The count columns a governed session read must select.
 *
 * Each is an aggregate over a child relation with `deleted_at is null` applied
 * to the CHILD, which the caller attaches as a filter — the count is only
 * meaningful with the live filter on, and the DB suite proves the filter reaches
 * it.
 */
export const CHARTED_COUNT_COLUMNS =
  "live_block_count:session_blocks(count), " +
  "live_entry_count:electrolysis_entries(count), " +
  "live_laser_count:laser_entries(count), " +
  // Whether this visit recorded a caution, decided the same way. The OR mirrors
  // the shared watch-line rule in lib/sessions/clinical-summary.ts — a block
  // counts when it is FLAGGED to watch or carries a note, and either alone is
  // enough.
  "caution_count:session_blocks(count)";

/** PostgREST renders a per-parent aggregate as a one-element array. */
type CountEmbed = ReadonlyArray<{ count: number }> | null | undefined;

/** A session row carrying its own charted-ness evidence. */
export type ChartedEvidenceRow = {
  live_block_count?: CountEmbed;
  live_entry_count?: CountEmbed;
  live_laser_count?: CountEmbed;
  caution_count?: CountEmbed;
};

function readCount(embed: CountEmbed): number | null {
  if (!Array.isArray(embed) || embed.length === 0) return null;
  const n = embed[0]?.count;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Does this visit contain charting?
 *
 * `true` and `false` are BOTH AUTHORITATIVE: they come from aggregates over the
 * whole child relation, not from rows that may have been cut.
 *
 * `null` means the evidence did not arrive — a caller selected the row without
 * the count columns. It is UNDECIDABLE, never `false`. Reading a missing count as
 * zero is the same mistake as reading a missing map entry as an empty list, and
 * it is the mistake this module exists to remove.
 *
 * Conjunctive across the three channels: one missing count poisons the answer,
 * because a session with no blocks may still be a legacy entry-only visit.
 */
export function isChartedFromCounts(row: ChartedEvidenceRow): boolean | null {
  const blocks = readCount(row.live_block_count);
  const entries = readCount(row.live_entry_count);
  const laser = readCount(row.live_laser_count);
  if (blocks === null || entries === null || laser === null) return null;
  return blocks > 0 || entries > 0 || laser > 0;
}

/**
 * Does this visit have at least one live settings block?
 *
 * The evidence behind "Latest setup": a setup can only be recorded on a block,
 * so the newest candidate with a live block is the newest that could carry one.
 */
export function hasLiveBlocksFromCounts(
  row: ChartedEvidenceRow,
): boolean | null {
  const n = readCount(row.live_block_count);
  return n === null ? null : n > 0;
}

/** How many live blocks the database says this visit has. Null when unread. */
export function liveBlockCount(row: ChartedEvidenceRow): number | null {
  return readCount(row.live_block_count);
}

/** Live electrolysis passes, per the database. Null when unread. */
export function liveEntryCount(row: ChartedEvidenceRow): number | null {
  return readCount(row.live_entry_count);
}

/** Live laser passes, per the database. Null when unread. */
export function liveLaserCount(row: ChartedEvidenceRow): number | null {
  return readCount(row.live_laser_count);
}

/**
 * Did this visit record a caution?
 *
 * Keeps the caution decision off the block collection entirely: the visit
 * carrying one is identified from an aggregate, and only THAT visit's blocks are
 * ever read for the wording.
 */
export function hasCautionFromCounts(row: ChartedEvidenceRow): boolean | null {
  const n = readCount(row.caution_count);
  return n === null ? null : n > 0;
}

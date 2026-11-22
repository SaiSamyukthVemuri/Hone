// THE API ROW CAP, stated once.
//
// PostgREST returns at most `max_rows` rows from ANY read, with no error and no marker, whatever `.limit()` was
// asked for. supabase/config.toml sets it (1000, which is also the hosted default). A read that returns exactly
// that many rows may have been CUT, and a cut read is not an answer: the missing rows could be the newest
// session's blocks, or the later areas of a visit.
//
// A read whose payload can legitimately reach the cap (a batch over a whole roster's sessions, ordered by
// something that is not recency) must therefore FAIL CLOSED: treat "at the cap" as "could not be read" and let
// the caller's existing unavailable path say so, never as a complete answer. Reads that are bounded below the
// cap by their own `.limit(n)` need no check.
//
// tests/lib/supabase/row-cap.test.ts pins this constant to supabase/config.toml, so the two cannot drift.
export const API_MAX_ROWS = 1000;

/** True when a result is exactly at (or somehow past) the API cap, so it may have been truncated. */
export function mayBeTruncated(rowCount: number): boolean {
  return rowCount >= API_MAX_ROWS;
}

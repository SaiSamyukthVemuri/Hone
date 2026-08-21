// THE ONE CANONICAL RECENCY ORDER.
//
// WHY THIS FILE EXISTS
// --------------------
// "Which visit was the previous one?" was answered in two different places that
// nothing kept equivalent: the SQL reads ordered `started_at DESC` with no
// tie-break, while `lib/sessions/charted-session.ts` re-sorted in JavaScript by
// `started_at` then `id DESC`. The SQL order is NOT TOTAL and the JS order IS,
// so a tie group straddling a LIMIT loses an arbitrary member and an older row
// is then presented as the newest.
//
// That is measurable on this schema, not hypothetical: a 54-row exact
// `started_at` tie under `ORDER BY started_at DESC LIMIT 13` returns nine
// different rows out of thirteen depending on whether the planner chooses a
// sequential scan or an index scan. Same query, same data, different answer.
//
// So there is ONE order, declared here, emitted into SQL from here, and never
// re-applied in JavaScript.
//
// WHY THAT MAKES THE REST OF THE AUTHORITY SMALL
// ----------------------------------------------
// PostgREST places `LIMIT` inside the same ordered statement as the ORDER BY —
// including the invisible `db-max-rows` cap, which lands in that slot even when
// the client sends no limit of its own. A bounded read therefore returns exactly
// the TOP-N by the ordering key.
//
// When the ordering key IS the recency key, the rows lost are a pure SUFFIX of
// the OLDEST rows, so THE NEWEST REGION IS ALWAYS INTACT. Recency questions are
// answerable from any non-empty result; only ABSENCE questions need a
// completeness signal. The theorem holds only while the order is TOTAL.
//
// Pure. No I/O. Client-safe.

/**
 * The canonical recency order for `sessions`, newest first.
 *
 * `started_at` is `timestamptz NOT NULL` and `id` is the primary key, so the
 * pair is a strict total order: two rows cannot tie on both.
 *
 * `id DESC` is a DETERMINISTIC TIE-BREAK, not a time signal. `sessions.id` is
 * `gen_random_uuid()` — random v4, with no time correlation whatsoever. It is
 * here to make the order total, and a future reader who takes it to mean
 * "newer" will be wrong. The direction matches
 * supabase/migrations/0157_whole_session_copy_setup.sql, which is the product's
 * own SECURITY DEFINER authority for "the newest prior session", so a read
 * surface using the opposite direction would disagree with the write path about
 * which visit is most recent.
 */
export const SESSION_RECENCY_ORDER = [
  { column: "started_at", ascending: false },
  { column: "id", ascending: false },
] as const;

/** The minimum shape a PostgREST query builder must expose to be ordered here. */
type Orderable<Q> = {
  order(column: string, options: { ascending: boolean }): Q;
};

/**
 * Apply the canonical recency order to a query.
 *
 * THE ONLY WAY a governed historical read may be ordered. Hand-writing
 * `.order("started_at", …)` at a call site is what produced a non-total order in
 * three separate files.
 */
export function applySessionRecencyOrder<Q extends Orderable<Q>>(query: Q): Q {
  let out = query;
  for (const key of SESSION_RECENCY_ORDER) {
    out = out.order(key.column, { ascending: key.ascending });
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE CUTOFF COMPARISON — the one place JavaScript may look at an instant
// ---------------------------------------------------------------------------
//
// The authority never SORTS in JavaScript: the database produces the canonical
// order and every later step preserves it, because `Array.prototype.filter` and
// `map` visit in ascending index order.
//
// One comparison survives, and it is a FILTER rather than a sort: a batched read
// is fetched once with the loosest cutoff in the batch, and each appointment
// then keeps only the rows strictly before ITS OWN `starts_at`.
//
// That comparison must be exact, and `new Date(x).getTime()` is not.
// `timestamptz` carries MICROSECONDS and PostgREST serialises all six digits
// ("2026-07-22T01:52:01.026988+00:00"), while V8 truncates to milliseconds — so
// two instants 200µs apart are strictly ordered in Postgres and exactly EQUAL in
// JavaScript.

/** An instant at full database precision: whole seconds plus microseconds. */
export type CanonicalInstant = {
  readonly epochSeconds: number;
  readonly micros: number;
};

const ISO_WITH_OPTIONAL_FRACTION =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a PostgREST timestamptz into an exact instant, or null if unparseable.
 *
 * The fraction is read as TEXT and padded to six digits rather than multiplied
 * through a float, so `.5` and `.500000` — Postgres trims trailing zeros —
 * resolve to the same 500000µs. The seconds portion is parsed with `Date` only
 * AFTER the fraction is removed, which keeps that call exact (a whole-second
 * instant is representable in milliseconds) and lets the platform resolve the
 * UTC offset rather than reimplementing calendar arithmetic.
 */
export function parseCanonicalInstant(
  iso: string | null | undefined,
): CanonicalInstant | null {
  if (typeof iso !== "string") return null;
  const match = ISO_WITH_OPTIONAL_FRACTION.exec(iso.trim());
  if (!match) return null;
  const [, secondsPart, fraction, offset] = match;
  const ms = new Date(`${secondsPart}${offset}`).getTime();
  if (!Number.isFinite(ms)) return null;
  return {
    epochSeconds: ms / 1000,
    micros: fraction ? Number((fraction + "000000").slice(0, 6)) : 0,
  };
}

/**
 * Is `instant` strictly earlier than `cutoff`, at full database precision?
 *
 * Returns null when either side cannot be parsed. A caller must treat null as
 * UNKNOWN and refuse the row — never as `false`, which would silently admit a
 * session the appointment boundary was supposed to exclude.
 */
export function isStrictlyBeforeCanonical(
  instant: string | null | undefined,
  cutoff: string | null | undefined,
): boolean | null {
  const a = parseCanonicalInstant(instant);
  const b = parseCanonicalInstant(cutoff);
  if (!a || !b) return null;
  if (a.epochSeconds !== b.epochSeconds) return a.epochSeconds < b.epochSeconds;
  return a.micros < b.micros;
}

// Keyset pagination for the appointment-reminder passes.
//
// Lives here rather than in the route because a Next.js route file may export
// only its handlers and a fixed set of config values — and because a predicate
// this load-bearing should be testable on its own terms.
//
// WHY A KEYSET AND NOT AN OFFSET. Eligibility changes underneath a paging run:
// a row sends and stamps its sent column, another is cancelled, a third has its
// attempts exhausted. An OFFSET names a COUNT of rows that preceded the page,
// so when the prefix shrinks mid-run the offset silently steps OVER rows that
// were never examined. A keyset names a POSITION in the ordering, so a shrinking
// prefix cannot move it.

/** A position in the (starts_at, id) ordering. Exclusive. */
export type ReminderCursor = { startsAt: string; id: string };

/**
 * The PostgREST `or` filter expressing `(starts_at, id) > (startsAt, id)`.
 *
 * PostgREST has no row-value comparison, so the strict tuple inequality is
 * written as the equivalent disjunction: a strictly later start, OR the same
 * start with a later id. The `id` half is not decoration — without it two
 * appointments sharing a `starts_at` have no defined order, and a cursor could
 * re-emit one while skipping the other.
 *
 * Returns null for the first page, where there is no position to be after.
 */
export function keysetFilter(after: ReminderCursor | null): string | null {
  if (!after) return null;
  return `starts_at.gt.${after.startsAt},and(starts_at.eq.${after.startsAt},id.gt.${after.id})`;
}

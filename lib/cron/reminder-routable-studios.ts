// FAIRNESS BY SELECTION, NOT BY POSITION.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// A routing refusal is free: nothing sent, no attempt claimed, sent column left
// null. So the row's ELIGIBILITY IS UNCHANGED and it sorts into exactly the
// same position on the next pass.
//
// Keyset paging past those rows fixed the symptom for one invocation and moved
// the boundary from 50 to MAX_SCAN_ROWS: every later invocation still starts
// from the beginning, so a large enough unroutable prefix hides a routable
// suffix forever. Raising the ceiling, widening the limit, reversing the order
// or shuffling would all move that number without removing the property.
//
// The defect is that UNROUTABLE ROWS OCCUPY THE PAGE AT ALL. Remove them from
// selection and there is nothing to page past:
//
//   1. enumerate the DISTINCT studios among this window's eligible candidates
//   2. resolve each studio's sender ONCE
//   3. select appointments only for studios that actually resolved
//
// A studio with no usable sender contributes no rows, so it cannot crowd out a
// routable studio no matter how many appointments it has or how early they
// sort. Fairness becomes structural rather than positional, and holds across
// invocations without any persisted progress — no cursor, no schema, no new
// state authority to get wrong.
//
// ---------------------------------------------------------------------------
// WHY NOT A PERSISTED CURSOR
// ---------------------------------------------------------------------------
//
// Hone has no durable cron-progress mechanism today. `lib/cron/reminder-
// heartbeat.ts` records run HEALTH — recency and cadence — not position, and
// storing a scan cursor in a health record would make an operational signal
// carry execution authority it was never designed to hold. Introducing a new
// table for it would need schema, a migration and its own correctness argument.
// None of that is necessary once the selection itself is fair.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
//
// NOT a cache with authority. The resolution map lives for one invocation and
// is discarded; nothing reads it afterwards, and it never decides whether a
// send is permitted. The send helper re-resolves and re-refuses on its own for
// every row — this only decides which rows are worth LOADING. A studio that
// becomes unroutable between enumeration and send is still refused at the
// authority, fail-closed, exactly as before.

/** One studio's resolution outcome, reduced to the only question asked here. */
export type StudioRoutability = { studioId: string; routable: boolean };

export type RoutablePartition = {
  /** Studios whose sender resolved. Only these contribute candidate rows. */
  routable: string[];
  /** Studios that refused. Excluded from selection for this invocation. */
  unroutable: string[];
};

/**
 * Split candidate studios by whether they can send.
 *
 * Order-stable so a run's behaviour is reproducible and the emitted evidence
 * lists studios in a predictable order. Duplicates are collapsed: the caller
 * enumerates studio ids from appointment rows, so the same studio arrives once
 * per appointment.
 */
export function partitionRoutableStudios(
  results: ReadonlyArray<StudioRoutability>,
): RoutablePartition {
  const seen = new Set<string>();
  const routable: string[] = [];
  const unroutable: string[] = [];
  for (const r of results) {
    if (seen.has(r.studioId)) continue;
    seen.add(r.studioId);
    (r.routable ? routable : unroutable).push(r.studioId);
  }
  return { routable, unroutable };
}

/**
 * Whether the pass may report that candidates were TRUNCATED.
 *
 * Reaching exactly the page limit is NOT evidence that more existed — a set of
 * exactly `limit` rows fills the page and ends. Truncation may only be claimed
 * when a further row was actually observed, which is what the `+1` lookahead
 * row is for.
 *
 * Getting this wrong is not cosmetic: a pass that cries truncation on a
 * complete set teaches an operator to ignore the signal, and by the time it is
 * real nobody looks.
 */
export function truncationProven(opts: {
  /** Rows returned by the query, which requested `limit + 1`. */
  returned: number;
  /** The page limit the pass actually intends to process. */
  limit: number;
}): boolean {
  return opts.returned > opts.limit;
}

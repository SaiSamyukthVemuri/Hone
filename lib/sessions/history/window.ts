// FOUR OUTCOMES, AND THE ONE THAT CANNOT BE FAKED.
//
// Every historical question this product asks has four honest answers, and the
// defect family comes from collapsing them to two:
//
//   observed      — here is the visit, and here is the evidence for it;
//   none          — there is genuinely none, and we read far enough to say so;
//   indeterminate — we could not read far enough to rule one out;
//   failed        — the read did not happen.
//
// `pickNewestChartedSession` returns `T | null`. A first-visit client, a client
// whose blocks read failed, and a client whose history fell past an invisible
// row cap are all the same `null`, so every caller renders the same sentence for
// three different situations — and one of them ("New client · No charted history
// yet") is a clinical claim about a person.
//
// `none` is the only outcome that licenses an absence sentence, and it is
// reachable ONLY from a COMPLETE window. That single line is the difference
// between "there is none" and "we did not read far enough".
//
// Pure. No I/O. Client-safe.

/**
 * How much of the client's history the read actually covered.
 *
 * `exhausted` carries its numbers so a log line can say how badly, and so the
 * distinction survives review: a bound that was merely REACHED is not evidence
 * of anything, but a bound that was EXCEEDED means rows exist that we never saw.
 */
export type HistoricalBound =
  | { kind: "complete" }
  | { kind: "exhausted"; returned: number; limit: number };

declare const HISTORICAL_WINDOW: unique symbol;

/**
 * A bounded, canonically ordered slice of one client's prior visits.
 *
 * The brand is MODULE-PRIVATE and is never exported. A consumer cannot spell
 * this type's witness, so it cannot forge a window out of an array it happens to
 * hold — which is precisely the move that made the previous authority advisory.
 */
export type HistoricalWindow<T> = {
  readonly rows: ReadonlyArray<T>;
  readonly bound: HistoricalBound;
  readonly [HISTORICAL_WINDOW]: true;
};

/**
 * Construct a window. THE AUTHORITY ONLY.
 *
 * Named to be unpleasant at a call site on purpose, and pinned by the source
 * guards: `rows` must already be in the canonical order, and `bound` must
 * describe the read that produced them. Nothing downstream re-checks either.
 */
export function unsafeCreateHistoricalWindow<T>(
  rows: ReadonlyArray<T>,
  bound: HistoricalBound,
): HistoricalWindow<T> {
  return { rows, bound } as HistoricalWindow<T>;
}

export type HistoricalAnswer<T> =
  | { kind: "observed"; value: T }
  | { kind: "none" }
  | { kind: "indeterminate" }
  | { kind: "failed" };

/**
 * The TOTAL eliminator. Every caller handles all four cases.
 *
 * There is deliberately no `unwrapOr`, no `valueOrNull`, no `?? default`. Any of
 * those would let a caller re-collapse the four states at the boundary, which is
 * the exact move this module exists to prevent — and TypeScript would not
 * complain, because the collapsed value type is perfectly well formed.
 */
export function matchHistorical<T, R>(
  answer: HistoricalAnswer<T>,
  handlers: {
    observed: (value: T) => R;
    none: () => R;
    indeterminate: () => R;
    failed: () => R;
  },
): R {
  switch (answer.kind) {
    case "observed":
      return handlers.observed(answer.value);
    case "none":
      return handlers.none();
    case "indeterminate":
      return handlers.indeterminate();
    case "failed":
      return handlers.failed();
  }
}

/**
 * The newest row satisfying a RECENCY claim — "the latest X".
 *
 * CONJUNCTIVE, and that is the whole point. A row whose own evidence is
 * UNDECIDABLE (`decide` returns null) poisons everything older than it, because
 * an older match can only be "the latest" if nothing newer beats it. Skipping the
 * undecidable row and returning the older one is how a stale superlative ships.
 */
export function newestWhere<T>(
  window: HistoricalWindow<T>,
  decide: (row: T) => boolean | null,
): HistoricalAnswer<T> {
  for (const row of window.rows) {
    const verdict = decide(row);
    if (verdict === null) return { kind: "indeterminate" };
    if (verdict) return { kind: "observed", value: row };
  }
  // Nothing matched. That is an ABSENCE claim, and absence needs the WHOLE
  // window: an exhausted read may simply not have reached the match.
  return window.bound.kind === "complete"
    ? { kind: "none" }
    : { kind: "indeterminate" };
}

/**
 * A row carrying a BARE POSITIVE fact — one that asserts only "this was
 * recorded" and claims nothing about being the newest.
 *
 * Separate from `newestWhere` on purpose. A caution is the standing example:
 * `pickPreClientWatchPlanSource` in lib/sessions/clinical-summary.ts documents
 * the product rule that "a newer charted session WITHOUT notes no longer hides
 * the previous session's still-relevant guidance", so surfacing an older caution
 * is intended. Making this conjunctive would delete a recorded clinical caution
 * because a DIFFERENT visit's evidence did not arrive.
 *
 * It still cannot invent an absence: not finding one under an exhausted read is
 * `indeterminate`, never `none`.
 */
export function observedWhere<T>(
  window: HistoricalWindow<T>,
  predicate: (row: T) => boolean,
): HistoricalAnswer<T> {
  for (const row of window.rows) {
    if (predicate(row)) return { kind: "observed", value: row };
  }
  return window.bound.kind === "complete"
    ? { kind: "none" }
    : { kind: "indeterminate" };
}

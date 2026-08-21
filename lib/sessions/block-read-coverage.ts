// HOW MUCH OF THE BLOCK READ DID WE ACTUALLY SEE?
//
// WHY THIS EXISTS
// ---------------
// The positive-evidence model says an observed fact may be rendered and an
// unread row renders nothing. That is sufficient for ABSENCE claims, and it is
// NOT sufficient for SUPERLATIVE ones.
//
// "Latest setup" and "Last treatment" do not merely assert that something was
// observed. They assert a RANKING: that nothing newer and relevant exists. A
// bounded read can satisfy the first and falsify the second at the same time —
// the older setup really was recorded, and a newer one really did exist in a
// row we never received. Positive evidence proves "this existed". It cannot
// prove "nothing newer existed".
//
// So a recency claim needs one extra thing that a bare fact does not: evidence
// that no relevant NEWER candidate went unread.
//
// WHY IT IS SHAPED LIKE THIS
// --------------------------
// Deliberately NOT another `briefingComplete: boolean` on the prep model. That
// is the shape PR #608 died of: a general-purpose completeness flag on a public
// model is an invitation for the next caller to use it to license some other
// sentence, and it must then be right about a read it does not describe.
//
// This is a narrow discriminated union, owned by the loader and consumed only
// by the observers and the selector guard in this directory. It never reaches
// the Dashboard model, and there is a source guard that keeps it there. The UI
// receives FACTS or NOTHING; it is never handed completeness authority to
// interpret.
//
// Pure. No I/O. Client-safe.

/**
 * `complete`           — the read returned every matching row, so a session
 *                        absent from the block map genuinely has no live blocks.
 * `possibly_truncated` — the response reached its bound. A session absent from
 *                        the map may have blocks we simply did not receive, so
 *                        its content is UNKNOWN rather than empty.
 */
export type BlockReadCoverage =
  | { kind: "complete" }
  | { kind: "possibly_truncated"; returned: number; limit: number };

/**
 * Classify a bounded read by the only evidence we have: how many rows came back
 * against the bound we asked for.
 *
 * CONSERVATIVE ON PURPOSE. A response that exactly fills its bound is
 * indistinguishable from one that was cut at it — PostgREST returns 200 either
 * way, with no marker — so an exactly-full response is treated as possibly
 * truncated. Assuming 200 means complete is precisely the mistake that produced
 * this defect.
 *
 * THE BOUND MUST NOT EXCEED PostgREST's OWN `max_rows` (supabase/config.toml).
 * If it did, the server would clamp BELOW our limit, `returned` would never
 * reach `limit`, and this would report `complete` for a truncated read — the
 * same failure wearing a different number. That relationship is pinned in
 * tests/source-guards/prep-absence-guards.test.ts rather than left to memory.
 */
export function classifyBlockReadCoverage(
  returned: number,
  limit: number,
): BlockReadCoverage {
  return returned >= limit
    ? { kind: "possibly_truncated", returned, limit }
    : { kind: "complete" };
}

/**
 * May a session absent from the block map be treated as genuinely blockless?
 *
 * Only under complete coverage. This is the single question the whole type
 * exists to answer, and routing every caller through it is what stops the
 * `continue`-past-an-unread-row idiom from reappearing: skipping a row is a
 * claim about that row, and under a truncated read it is not one we can make.
 */
export function absentMeansEmpty(coverage: BlockReadCoverage): boolean {
  return coverage.kind === "complete";
}

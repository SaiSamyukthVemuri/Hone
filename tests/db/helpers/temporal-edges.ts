/**
 * WAIT-03 — THE TEMPORAL EDGE MANIFEST.
 *
 * IDENTITIES AND REQUIRED EVIDENCE ONLY. No row here records a result, and no
 * row here can certify anything: a row names the two transitions that meet, the
 * primitive that orders them, and WHAT KIND of executable proof that boundary
 * demands. Closure is derived in
 * tests/migrations/0189-waitlist-invitation-wall-clock-expiry.test.ts, which
 * reads the implementing test and fails when the evidence is missing.
 *
 * WHY THIS FILE EXISTS. It replaced a hand-written truth table whose only
 * assertion was that each label it contained was one of the two labels it
 * allowed:
 *
 *     expect(["EXECUTED_RACE", "STRUCTURALLY_IMPOSSIBLE"]).toContain(row.proof)
 *
 * That construct proved we had typed an allowed word. It stayed green when the
 * tests behind it were deleted, and it certified an edge — RELEASE/EXPIRE ->
 * REQUEUE — whose successor was not even in the mutex census it appealed to.
 * The invariant here is EVIDENCE -> CLOSURE, never LABEL -> CLOSURE.
 *
 * ADDING AN EDGE. Add the row, then write the test whose title carries
 * `edgeTitle(<id>, …)`. The guard fails until the implementing test exists and
 * carries the evidence its proof kind requires, so the row cannot run ahead of
 * the proof.
 */

/** How a boundary can be proven. Neither kind is stronger; they describe
 *  different mechanisms, and using the wrong one is itself a defect. */
export const PROOF_KINDS = [
  /** The successor genuinely PARKED on a lock the predecessor held, proven by
   *  polling pg_stat_activity until wait_event_type = 'Lock', and only then was
   *  the predecessor released. A timer or a Promise delay is not this. */
  "EXECUTED_BLOCKING_RACE",
  /** No blocking schedule exists, because the predecessor's row is invisible to
   *  the successor until it commits. Proven by showing the successor cannot see
   *  the uncommitted row, then that the post-commit transition is ordered. */
  "MVCC_VISIBILITY_ORDERED",
  /** No blocking schedule exists, because the successor's own WHERE clause does
   *  not match the row version it can see. The row is there; the STATE the
   *  successor requires is not, so the statement matches zero rows and never
   *  reaches a lock. Proven by showing the successor refuses — writing nothing —
   *  while the predecessor is uncommitted, and is ordered once it commits.
   *
   *  MEASURED, NOT ASSUMED. This edge was first written as an executed race, on
   *  the reasoning that REQUEUE's UPDATE would take a row lock like any other.
   *  It does not: with the predecessor uncommitted, REQUEUE returns
   *  `not_requeueable` immediately and never waits at all. Keeping the race
   *  label would have meant asserting a schedule PostgreSQL does not produce. */
  "PREDICATE_VISIBILITY_ORDERED",
] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

/** What the successor is asserted to DO once the boundary is crossed. */
export const VERDICTS = ["ORDERED", "REFUSED"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * The EXACT source tokens an implementing test must contain. The guard reads
 * these constants rather than hand-typed regexes, so the evidence contract has
 * exactly one definition and a renamed helper cannot silently stop being
 * required.
 */
export const MECHANISM_EVIDENCE: Record<ProofKind, string> = {
  EXECUTED_BLOCKING_RACE: "proveBlockedOn(",
  MVCC_VISIBILITY_ORDERED: "proveInvisibleWhileUncommitted(",
  PREDICATE_VISIBILITY_ORDERED: "proveNotYetVisible(",
};

export const VERDICT_EVIDENCE: Record<Verdict, string> = {
  ORDERED: "expectOrdered(",
  REFUSED: "expectRefused(",
};

/** The predecessor must be released INSIDE the test, after the successor is
 *  proven parked. At least one of these must appear. */
export const PREDECESSOR_RELEASE = ['.query("commit")', '.query("rollback")'] as const;

/** The eight canonical WAIT-03 transitions. Two of them are aggregates: a
 *  single label cannot certify materially different mechanisms, so they are
 *  implemented as several concrete edges and re-joined here. */
export const CANONICAL_EDGES = [
  "JOIN -> CLAIM",
  "CLAIM -> INVITE",
  "INVITE -> REDEEM",
  "INVITE -> EXPIRE",
  "INVITE -> RELEASE",
  "REDEEM -> CONVERT",
  "RELEASE/EXPIRE -> REQUEUE",
  "WAITING/RELEASED/EXPIRED -> REMOVE",
] as const;
export type CanonicalEdge = (typeof CANONICAL_EDGES)[number];

export type TemporalEdge = {
  /** Appears verbatim in the implementing test's title, via `edgeTitle`. */
  readonly id: string;
  readonly canonical: CanonicalEdge;
  readonly predecessor: string;
  readonly successor: string;
  /** The primitive that orders the two. Prose, for the reader. */
  readonly boundary: string;
  readonly proof: ProofKind;
  readonly verdicts: readonly Verdict[];
};

export const TEMPORAL_EDGES: readonly TemporalEdge[] = [
  {
    id: "JOIN->CLAIM",
    canonical: "JOIN -> CLAIM",
    predecessor: "join_new_client_waitlist",
    successor: "claim_new_client_waitlist_entry",
    // JOIN inserts a brand-new row. There is nothing for a claimer to park on,
    // because there is nothing it can see: an uncommitted insert is invisible,
    // so the claim answers not_found rather than blocking. Calling this an
    // executed race would be a fiction — the successor never waits.
    boundary: "MVCC visibility of the newly inserted entry row",
    proof: "MVCC_VISIBILITY_ORDERED",
    verdicts: ["REFUSED", "ORDERED"],
  },
  {
    id: "CLAIM->INVITE",
    canonical: "CLAIM -> INVITE",
    predecessor: "claim_new_client_waitlist_entry",
    successor: "issue_new_client_waitlist_invitation",
    boundary: "the entry row mutex both commands take FOR UPDATE",
    proof: "EXECUTED_BLOCKING_RACE",
    verdicts: ["ORDERED"],
  },
  {
    id: "INVITE->REDEEM",
    canonical: "INVITE -> REDEEM",
    predecessor: "a holder of the invitation row",
    successor: "redeem_new_client_waitlist_invitation",
    boundary: "the invitation row lock — the only lock REDEEM takes",
    proof: "EXECUTED_BLOCKING_RACE",
    verdicts: ["REFUSED"],
  },
  {
    id: "INVITE->EXPIRE",
    canonical: "INVITE -> EXPIRE",
    predecessor: "a holder of the invitation row",
    successor: "expire_new_client_waitlist_invitation",
    boundary: "the entry mutex, then the invitation row lock",
    proof: "EXECUTED_BLOCKING_RACE",
    verdicts: ["ORDERED"],
  },
  {
    id: "INVITE->RELEASE",
    canonical: "INVITE -> RELEASE",
    predecessor: "a holder of the invitation row",
    successor: "release_new_client_waitlist_entry",
    boundary: "the entry mutex, then the invitation row lock",
    proof: "EXECUTED_BLOCKING_RACE",
    verdicts: ["ORDERED"],
  },
  {
    id: "REDEEM->CONVERT",
    canonical: "REDEEM -> CONVERT",
    predecessor: "redeem_new_client_waitlist_invitation",
    successor: "record_new_client_waitlist_conversion",
    // REDEEM is the one command that does not take the entry mutex, so the
    // conversion cannot be ordered behind it structurally. It has to contend on
    // the invitation row the redemption itself holds.
    boundary: "the invitation row lock held by the in-flight redemption",
    proof: "EXECUTED_BLOCKING_RACE",
    verdicts: ["ORDERED"],
  },
  {
    id: "RELEASE->REQUEUE",
    canonical: "RELEASE/EXPIRE -> REQUEUE",
    predecessor: "release_new_client_waitlist_entry",
    successor: "requeue_new_client_waitlist_entry",
    // REQUEUE takes no explicit FOR UPDATE, and — measured, not assumed — it
    // takes no implicit one either while the release is in flight: its
    // `status in ('released','expired')` predicate does not match the row
    // version other sessions can see, so the UPDATE matches zero rows and never
    // waits. A "both bodies contain FOR UPDATE" census could not have covered
    // this edge, and neither could a race test, because there is no race.
    boundary: "REQUEUE's own status predicate, against the pre-commit row version",
    proof: "PREDICATE_VISIBILITY_ORDERED",
    verdicts: ["REFUSED", "ORDERED"],
  },
  {
    id: "EXPIRE->REQUEUE",
    canonical: "RELEASE/EXPIRE -> REQUEUE",
    predecessor: "expire_new_client_waitlist_invitation",
    successor: "requeue_new_client_waitlist_entry",
    boundary: "REQUEUE's own status predicate, against the pre-commit row version",
    proof: "PREDICATE_VISIBILITY_ORDERED",
    verdicts: ["REFUSED", "ORDERED"],
  },
  {
    id: "RELEASE->REMOVE",
    canonical: "WAITING/RELEASED/EXPIRED -> REMOVE",
    predecessor: "release_new_client_waitlist_entry",
    successor: "remove_new_client_waitlist_entry",
    boundary: "the entry mutex both commands take FOR UPDATE",
    proof: "EXECUTED_BLOCKING_RACE",
    verdicts: ["ORDERED"],
  },
  {
    id: "EXPIRE->REMOVE",
    canonical: "WAITING/RELEASED/EXPIRED -> REMOVE",
    predecessor: "expire_new_client_waitlist_invitation",
    successor: "remove_new_client_waitlist_entry",
    boundary: "the entry mutex both commands take FOR UPDATE",
    proof: "EXECUTED_BLOCKING_RACE",
    verdicts: ["ORDERED"],
  },
  {
    id: "REQUEUE->REMOVE",
    canonical: "WAITING/RELEASED/EXPIRED -> REMOVE",
    predecessor: "requeue_new_client_waitlist_entry",
    successor: "remove_new_client_waitlist_entry",
    // The OTHER way an entry reaches `waiting`. It is a different mechanism from
    // JOIN -> REMOVE — a live row being updated, not a row that does not yet
    // exist — so it gets its own edge rather than sharing a label.
    boundary: "the entry mutex, against REQUEUE's in-flight UPDATE",
    proof: "EXECUTED_BLOCKING_RACE",
    verdicts: ["ORDERED"],
  },
  {
    id: "JOIN->REMOVE",
    canonical: "WAITING/RELEASED/EXPIRED -> REMOVE",
    predecessor: "join_new_client_waitlist",
    successor: "remove_new_client_waitlist_entry",
    boundary: "MVCC visibility of the newly inserted entry row",
    proof: "MVCC_VISIBILITY_ORDERED",
    verdicts: ["REFUSED", "ORDERED"],
  },
];

/** The implementing test's title. The edge id is embedded verbatim so the guard
 *  can find the one test that carries it — and so deleting that test removes the
 *  id from the file and turns closure red. */
export const edgeTitle = (id: string, what: string): string => `[${id}] ${what}`;

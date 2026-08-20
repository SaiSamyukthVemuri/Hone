import {
  resolveNextAction,
  type NextAction,
  type NextActionInput,
} from "@/lib/dashboard/next-action";

// ===========================================================================
// THE PRIMARY ACTION FOR A ROW ON A SELECTED DAY
// ===========================================================================
//
// `resolveNextAction` answers "returning client or not?" in its last branch,
// and it takes that fact as a plain boolean. That is correct for TODAY, where
// the Dashboard genuinely asks the history question.
//
// On any other day this V1 does NOT ask it. The Before-Today load and the
// prep-memory load are both skipped, so there is no answer to pass — and
// passing `false` would be a fabricated one. "We did not ask" is not "no
// history", and a ten-year client reading "Open client" because a question was
// never posed is the same untruth as reading "New client".
//
// So this wrapper reproduces the GUARD rather than the value.
//
// `resolveNextAction` reaches `hasHistory` only after three earlier branches
// fall through: a linked session, a completed appointment, and
// cancelled/no-show. Those branches never read it. When one of them applies,
// this delegates and the boolean is provably inert. When none does — the
// upcoming, uncharted, not-cancelled row — this returns the neutral action
// itself, without calling the resolver at all.
//
// Written this way on purpose: a bare `hasHistory: isToday && preview.hasHistory`
// at the call site would look equivalent and would silently become wrong the
// day someone adds a fourth branch to `resolveNextAction` that reads the flag.
// Encoding the guard here keeps it correct under that edit.

/**
 * Whether the history question was asked for this row, and its answer.
 *
 * A discriminated union, not an optional boolean: `{ asked: false }` carries no
 * answer field at all, so there is nothing to accidentally read as `false`.
 */
export type RowHistory =
  | { asked: true; hasHistory: boolean }
  | { asked: false };

/** The branches of `resolveNextAction` that are decided before history. */
function decidedWithoutHistory(
  input: Omit<NextActionInput, "hasHistory">,
): boolean {
  return (
    input.sessionId !== null ||
    input.status === "completed" ||
    input.status === "cancelled" ||
    input.status === "no_show"
  );
}

export function resolveDayNextAction(
  input: Omit<NextActionInput, "hasHistory"> & { history: RowHistory },
): NextAction {
  const { history, ...rest } = input;

  // TODAY: delegate verbatim, so today's action is bit-for-bit what production
  // renders. Nothing is post-processed here.
  if (history.asked) {
    return resolveNextAction({ ...rest, hasHistory: history.hasHistory });
  }

  // Not asked. Where history cannot reach the outcome, the resolver is still
  // the authority — this passes `false` only after proving it is unreachable.
  if (decidedWithoutHistory(rest)) {
    return resolveNextAction({ ...rest, hasHistory: false });
  }

  // The upcoming, uncharted row. NEUTRAL by choice: "Open client" asserts
  // nothing about whether this person is new or returning, and its destination
  // is correct either way. It is not "the new-client branch" — it is the
  // action that makes no claim.
  return { label: "Open client", href: `/clients/${rest.clientId}`, chip: null };
}

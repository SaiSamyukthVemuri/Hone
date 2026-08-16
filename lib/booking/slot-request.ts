// AN ASYNC RESULT IS AUTHORISED BY THE IDENTITY OF THE REQUEST THAT PRODUCED
// IT -- and that identity is DERIVED FROM THE FETCH INPUTS, not hand-listed.
//
// WHY THIS SHAPE
// --------------
// Four consecutive repairs of these two booking surfaces each fixed one stale
// value and left another, because correctness depended on a human remembering
// two things: to bump a counter at every mutation site, and to list every
// dimension in a hand-written identity. Both are open-ended obligations, and
// both were missed -- most recently the capacity mode, which changes WHICH
// window the server reads without appearing in any argument.
//
// So the identity is not written by hand at the call site. It is computed from
// the request object, over ALL of that object's keys. Adding a field to
// `SlotCandidateIdentity` therefore extends the identity automatically, and the
// compiler forces every call site to supply it. Omission stops being a silent
// gap and becomes a type error.
//
// The generation counter survives only as cancellation machinery. It answers
// "is this the newest promise?", which is not the question. The question is
// "does this result describe the request the user is currently making?", and
// only the identity answers that -- notably in the case where NOTHING newer was
// ever issued and the inputs simply moved on underneath an in-flight request.

// EVERYTHING THAT DETERMINES WHAT A LOADED SLOT/WINDOW MEANS.
//
// Named for what it is. An earlier version called this the "fetch input" and
// reasoned that only literal action arguments belong in it -- which is how the
// capacity mode and the studio timezone were both left out. Neither is posted
// as an argument, and both change the interpretation and the SOURCE of the
// result: capacity mode selects which window the server reads, and the timezone
// decides what local date the request means and what instants come back.
//
// A loaded candidate is current only when ALL of this still matches.
export type SlotCandidateIdentity = {
  serviceId: string;
  date: string;
  // The literal argument sent to the action -- null when none is sent. Recorded
  // as the ARGUMENT rather than as adjacent component state, because those two
  // diverge: with capacity off the client sends null while the selected target
  // state still holds a practitioner id.
  practitionerId: string | null;
  // Not an argument, but the server reads studio.practitioner_capacity_enabled
  // and it changes which window source is authoritative. A non-owner sends null
  // in both modes, so the argument alone cannot capture this.
  capacityMode: boolean;
  // Not an argument either, but it changes what the date MEANS and what
  // instants the slots carry. A result generated under one zone must never
  // stay authoritative under another -- reformatting the display while keeping
  // the old instants would submit a time nobody chose.
  timezone: string;
};

/** EXACTLY the inputs that determine an eligible-practitioner fetch's result. */
export type EligibleFetchInput = {
  serviceId: string;
  // The action returns an empty list unless capacity is on and the actor owns
  // the studio, so the mode is part of what determines the answer.
  capacityMode: boolean;
};

// Derived over every key of the object. This is the whole point: the identity
// cannot fall behind the input type, because it is not written separately from
// it. NOTE the deliberate absence of duration -- the action's signature is
// (serviceId, date, practitionerId) and the server derives the length from the
// locked service row, so serviceId already determines it. Adding it would force
// refetches that cannot change the answer.
function identityOf<T extends Record<string, unknown>>(input: T): string {
  return JSON.stringify(
    (Object.keys(input) as (keyof T)[])
      .sort()
      .map((k) => [k, input[k] ?? null]),
  );
}

export function slotCandidateIdentity(input: SlotCandidateIdentity): string {
  return identityOf(input);
}

export function eligibleFetchIdentity(input: EligibleFetchInput): string {
  return identityOf(input);
}

export type CommitDecision<T> =
  // Explicitly superseded by a newer generation.
  | { kind: "discard"; reason: "superseded" }
  // Still the newest promise, but it answers for inputs that are no longer
  // current. A generation counter cannot see this case.
  | { kind: "discard"; reason: "identity_changed" }
  | { kind: "commit"; result: T };

// Runs the fetch and decides whether its result may commit.
//
// `fetch` is handed the SAME request object the identity was derived from, so
// the arguments actually sent are provably the ones the identity describes --
// a call site cannot declare one identity and then fetch something else.
export async function fetchForIdentity<I extends Record<string, unknown>, T>(input: {
  request: I;
  identityOf: (req: I) => string;
  // Read AFTER the await, never captured. Null means "no current request",
  // which never matches.
  readCurrentRequest: () => I | null;
  fetch: (request: I) => Promise<T>;
  // Optional cancellation machinery, checked alongside (never instead of) the
  // identity.
  generation?: number;
  isCurrentGeneration?: (generation: number) => boolean;
}): Promise<CommitDecision<T>> {
  const requested = input.identityOf(input.request);
  const result = await input.fetch(input.request);
  // Both checks happen AFTER the await. Checking either before it would let a
  // request that was superseded mid-flight still write.
  if (
    input.generation !== undefined &&
    input.isCurrentGeneration !== undefined &&
    !input.isCurrentGeneration(input.generation)
  ) {
    return { kind: "discard", reason: "superseded" };
  }
  const current = input.readCurrentRequest();
  if (current === null || input.identityOf(current) !== requested) {
    return { kind: "discard", reason: "identity_changed" };
  }
  return { kind: "commit", result };
}

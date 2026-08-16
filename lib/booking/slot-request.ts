// ASYNC SLOT/WINDOW RESULTS MAY COMMIT ONLY TO THE EXACT CURRENT BOOKING
// CANDIDATE IDENTITY THEY WERE REQUESTED FOR.
//
// Three consecutive repairs of this component's async path each left one more
// piece of state stale, because each relied on a GENERATION COUNTER and on
// every mutation site remembering to bump it. A counter answers "is this the
// newest promise?" -- which is not the question. The question is "does this
// result describe the booking that is on screen right now?", and only the
// identity can answer that.
//
// So both guards are used, and they do different jobs:
//
//   GENERATION  cancellation machinery. Cheap, and it discards work that has
//               been explicitly superseded.
//   IDENTITY    the semantic authority. Captured when the request is issued,
//               compared against the LIVE identity after the await. A response
//               does not become authoritative merely by being the last to
//               resolve.
//
// The identity is exactly the set of inputs the returned availability facts
// depend on: the service (which fixes duration and eligibility), the date, and
// the target practitioner whose calendar was read. The CLIENT is deliberately
// absent -- slots and windows do not vary by client, and adding dimensions that
// cannot change the answer would cause needless refetch churn. (The buffer
// EXCEPTION is client-scoped, but that is a different thing with its own
// identity; see bookingCandidateKey.)

export type SlotCandidateIdentity = {
  serviceId: string;
  date: string;
  targetPractitionerId: string;
};

export function sameSlotCandidate(
  a: SlotCandidateIdentity | null,
  b: SlotCandidateIdentity | null,
): boolean {
  if (!a || !b) return false;
  return (
    a.serviceId === b.serviceId &&
    a.date === b.date &&
    a.targetPractitionerId === b.targetPractitionerId
  );
}

export type SlotCommitDecision<T> =
  // Explicitly superseded by a newer generation.
  | { kind: "discard"; reason: "superseded" }
  // Still the newest promise, but it answers a question nobody is asking any
  // more. This is the case a generation counter alone cannot see: nothing
  // newer was ever issued, the identity simply moved on underneath it.
  | { kind: "discard"; reason: "identity_changed" }
  | { kind: "commit"; result: T };

export async function loadForCandidate<T>(input: {
  generation: number;
  isCurrentGeneration: (generation: number) => boolean;
  // Captured when the request is issued.
  captured: SlotCandidateIdentity;
  // Read AFTER the await, never captured.
  readCurrentIdentity: () => SlotCandidateIdentity | null;
  fetch: () => Promise<T>;
}): Promise<SlotCommitDecision<T>> {
  const result = await input.fetch();
  // Both checks happen after the await. Checking either one before it would
  // let a request that was superseded mid-flight still write.
  if (!input.isCurrentGeneration(input.generation)) {
    return { kind: "discard", reason: "superseded" };
  }
  if (!sameSlotCandidate(input.captured, input.readCurrentIdentity())) {
    return { kind: "discard", reason: "identity_changed" };
  }
  return { kind: "commit", result };
}

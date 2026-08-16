// THE ELIGIBLE-PRACTITIONER RESOLUTION STEP, extracted so its ORDERING can be
// tested rather than argued about.
//
// The bug this exists to prevent (Codex P2-B, itself introduced by the repair
// for the obsolete-date race):
//
//   1. the date changes, so a fresh eligibility request starts;
//   2. that request CAPTURES the target that was selected at the time;
//   3. before it resolves, the owner explicitly picks a different, still-
//      eligible practitioner;
//   4. the request resolves and resolves the default from its CAPTURED target;
//   5. the selector silently snaps back, and a newer slot/window load is
//      launched for the practitioner the owner just moved away from.
//
// A date change may invalidate stale async work. It may NOT silently revoke a
// later explicit choice. The two rules pull in opposite directions only if the
// captured value is treated as current authority -- so this helper never
// captures it. `readCurrentTarget` is a callback, invoked AFTER the await, so
// whatever the practitioner most recently chose is what it sees.
//
// Living in lib/ rather than the component is what lets a test drive the exact
// interleaving with deferred promises: start the resolution, change the target,
// then release the fetch.

export type EligibleLike = { id: string };

export type EligibleSelectionOutcome<P extends EligibleLike> =
  // A newer generation started while this was in flight. Discard entirely --
  // do not touch the list, the target, or anything downstream.
  | { kind: "superseded" }
  | { kind: "failed"; error: string }
  // The service has no eligible practitioners: booking must be blocked, and
  // the caller must NOT fall back to self.
  | { kind: "empty"; list: P[] }
  | { kind: "selected"; list: P[]; target: string };

export async function resolveEligibleSelection<P extends EligibleLike>(input: {
  // The generation this request was issued under.
  generation: number;
  // Whether that generation is still the newest. Checked only AFTER the await:
  // a request that was superseded mid-flight must not be able to write.
  isCurrent: (generation: number) => boolean;
  fetchEligible: () => Promise<
    { ok: true; practitioners: P[] } | { ok: false; error: string }
  >;
  // Read at RESOLVE time, never captured. This is the whole point.
  readCurrentTarget: () => string;
  // Preferred when the current target is not eligible (normally the acting
  // practitioner), before falling back to the first eligible one.
  preferredFallback: string;
}): Promise<EligibleSelectionOutcome<P>> {
  const r = await input.fetchEligible();
  if (!input.isCurrent(input.generation)) return { kind: "superseded" };
  if (!r.ok) return { kind: "failed", error: r.error };

  const list = r.practitioners;
  // PRECEDENCE, unchanged in substance from resolveDefaultTarget:
  //   a still-eligible current selection wins -> else the preferred fallback
  //   -> else the first eligible -> else nothing.
  // The only change is WHEN the current selection is read.
  const current = input.readCurrentTarget();
  if (list.some((p) => p.id === current)) {
    return { kind: "selected", list, target: current };
  }
  if (list.some((p) => p.id === input.preferredFallback)) {
    return { kind: "selected", list, target: input.preferredFallback };
  }
  const first = list[0]?.id;
  if (!first) return { kind: "empty", list };
  return { kind: "selected", list, target: first };
}

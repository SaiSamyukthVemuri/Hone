import { describe, expect, it } from "vitest";
import {
  INITIAL_CELEBRATION_STATE,
  celebrationReducer,
  isCelebrationSpent,
  type CelebrationEvent,
  type CelebrationState,
} from "@/lib/onboarding/celebration-machine";
import type { OnboardingModel } from "@/lib/onboarding/steps";

// PERF-01C. The celebration state machine, driven as transitions.
//
// These are DETERMINISTIC controls for races that e2e can only approximate: a
// server model landing while the stamp is unresolved is a genuine interleaving,
// and asserting on it through a browser means asserting on timing luck. Here the
// interleaving is written down.
//
// ANTI-VACUITY. Every control below was run against a faithful transcription of
// the pre-repair wizard — a `stampInFlight` ref, a `lastModel` ref, and the
// boolean pair `closedAfterShowing && stampConfirmed`, which is the same machine
// with every showing id collapsed onto 1. SEVEN read RED there:
//
//   * the P3 outcome, and the P3 mechanism
//   * "holds the newest model when several arrive during one request"
//   * "F: retiring suppression keeps the on-screen showing closable"
//   * "never lets an old close apply to a later distinct attempt"
//   * "never discards a server model merely because it arrived during a request"
//   * "ignores a settlement belonging to a superseded showing"
//
// The other nine passed on the old code too, and are here to pin behaviour that
// was already correct so the repair cannot regress it. Knowing WHICH is which is
// the difference between a control and a restatement of the implementation.

// A distinct object per call: the machine keys "the server has spoken again" on
// prop IDENTITY, exactly as the RSC payload delivers it.
function serverModel(shouldCelebrate: boolean): OnboardingModel {
  return {
    steps: [],
    currentStep: "done",
    doneCount: 6,
    totalCount: 6,
    requiredComplete: true,
    isComplete: false,
    shouldCelebrate,
    dismissed: false,
    publicBookingUrl: "https://example.test/book/studio",
  };
}

function drive(
  events: CelebrationEvent[],
  from: CelebrationState = INITIAL_CELEBRATION_STATE,
): CelebrationState {
  return events.reduce(celebrationReducer, from);
}

/** Shorthand: the owner is shown showing `n`, and its stamp goes out. */
const showing = (n: number): CelebrationEvent[] => [
  { type: "CELEBRATION_SHOWN", showing: n },
  { type: "STAMP_STARTED", showing: n },
];

describe("celebration machine — the deferred model is resolved, never dropped", () => {
  // The P3 as an OUTCOME, with no assertion about the mechanism that delivers
  // it. The sequence is steps 1-14 of the report verbatim. On the pre-repair
  // machine this ends `true`: the old close combines with the retry's stamp and
  // spends a celebration the owner is still looking at.
  it("the exact P3: a retry's stamp cannot be spent by a previous showing's close", () => {
    const afterRetry = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) }, //  1
      ...showing(1), //  2, 3
      { type: "OWNER_CLOSED_AFTER_SHOWING" }, //  4
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) }, //  5, 6, 7
      { type: "STAMP_REFUSED_OR_FAILED", showing: 1 }, //  8, 9, 10, 11
      { type: "OWNER_REOPENED" }, // 12
      ...showing(2), // 13
      { type: "STAMP_SUCCEEDED", showing: 2 },
    ]);
    // 14, 15: the newly owed celebration survives to be seen.
    expect(isCelebrationSpent(afterRetry)).toBe(false);
  });

  // The same failure, asserted on the mechanism that produces it.
  //
  // A positive model arrives while the stamp is pending. It is correctly NOT
  // acted on (it cannot have observed the outcome), but under the old code it
  // was recorded as `lastModel` and the in-flight marker was cleared in a REF —
  // so nothing ever reconsidered it. The old close stayed latched, and when the
  // owner reopened and the retry succeeded, that stale close combined with the
  // new stamp and spent a celebration the owner was still looking at.
  it("a positive model deferred during a REFUSED stamp is applied when it settles", () => {
    const beforeSettle = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) }, // 1
      ...showing(1), // 2, 3
      { type: "OWNER_CLOSED_AFTER_SHOWING" }, // 4
      // 5, 6: the dismissal revalidates /dashboard and returns a model that
      // still says the celebration is owed, because the stamp has not committed.
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
    ]);

    // 7: deferred rather than acted on — and HELD, which is the repair.
    expect(beforeSettle.inFlight).toBe(1);
    expect(beforeSettle.deferred).not.toBeNull();
    expect(beforeSettle.closed).toBe(1);

    // 8, 9, 10: the stamp is refused and the request settles.
    const settled = celebrationReducer(beforeSettle, {
      type: "STAMP_REFUSED_OR_FAILED",
      showing: 1,
    });

    // 11 inverted: the old close is RETIRED by the model that had been deferred.
    expect(settled.deferred).toBeNull();
    expect(settled.closed).toBe(0);
    expect(settled.stamped).toBe(0);
    expect(isCelebrationSpent(settled)).toBe(false);

    // 12, 13: the owner reopens and the retry succeeds.
    const retried = drive(
      [
        { type: "OWNER_REOPENED" },
        ...showing(2),
        { type: "STAMP_SUCCEEDED", showing: 2 },
      ],
      settled,
    );

    // 14, 15 inverted: the newly owed celebration is STILL ON SCREEN. It is not
    // spent until THIS showing is closed.
    expect(isCelebrationSpent(retried)).toBe(false);
    expect(
      isCelebrationSpent(
        celebrationReducer(retried, { type: "OWNER_CLOSED_AFTER_SHOWING" }),
      ),
    ).toBe(true);
  });

  // The mirror case, and the reason the resolution cannot simply always apply
  // the deferred model.
  it("a positive model deferred during a SUCCESSFUL stamp cannot undo the consumption", () => {
    const settled = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      ...showing(1),
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
      // Read before the write committed, so it is provably stale.
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      { type: "STAMP_SUCCEEDED", showing: 1 },
    ]);

    expect(settled.deferred).toBeNull();
    expect(isCelebrationSpent(settled)).toBe(true);

    // Reopening does not replay it.
    const reopened = drive([{ type: "OWNER_REOPENED" }], settled);
    expect(isCelebrationSpent(reopened)).toBe(true);
  });

  it("holds the newest model when several arrive during one request", () => {
    const last = serverModel(true);
    const state = drive([
      ...showing(1),
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      { type: "SERVER_MODEL_ARRIVED", model: last },
    ]);
    expect(state.deferred).toBe(last);
  });

  it("never strands a deferred model: a thrown or failed action still settles", () => {
    const state = drive([
      ...showing(1),
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      { type: "STAMP_REFUSED_OR_FAILED", showing: 1 },
    ]);
    expect(state.inFlight).toBe(0);
    expect(state.deferred).toBeNull();
  });
});

describe("celebration machine — required deterministic controls", () => {
  // A. show -> stamp succeeds -> close -> reopen -> no replay
  it("A: an ordinary successful stamp is spent once and does not replay", () => {
    const shownAndStamped = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      ...showing(1),
      { type: "STAMP_SUCCEEDED", showing: 1 },
    ]);
    // The owner must still SEE it: a confirmed stamp alone spends nothing.
    expect(isCelebrationSpent(shownAndStamped)).toBe(false);

    const closed = celebrationReducer(shownAndStamped, {
      type: "OWNER_CLOSED_AFTER_SHOWING",
    });
    expect(isCelebrationSpent(closed)).toBe(true);
    expect(
      isCelebrationSpent(
        celebrationReducer(closed, { type: "OWNER_REOPENED" }),
      ),
    ).toBe(true);
  });

  // B. show -> stamp refuses -> close -> positive model -> reopen -> offered again
  it("B: a refused stamp leaves the celebration owed", () => {
    const refused = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      ...showing(1),
      { type: "STAMP_REFUSED_OR_FAILED", showing: 1 },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
    ]);
    expect(refused.stamped).toBe(0);
    expect(isCelebrationSpent(refused)).toBe(false);

    const authoritative = celebrationReducer(refused, {
      type: "SERVER_MODEL_ARRIVED",
      model: serverModel(true),
    });
    expect(authoritative.closed).toBe(0);
    expect(isCelebrationSpent(authoritative)).toBe(false);
  });

  // C. show -> close immediately -> stamp succeeds -> reopen -> no replay
  it("C: closing before the stamp resolves still settles correctly", () => {
    const settled = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      ...showing(1),
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
      { type: "STAMP_SUCCEEDED", showing: 1 },
    ]);
    expect(isCelebrationSpent(settled)).toBe(true);
  });

  // F. a genuinely fresh positive model AFTER settlement regains authority
  it("F: a fresh positive model after settlement makes it eligible again", () => {
    const spent = drive([
      ...showing(1),
      { type: "STAMP_SUCCEEDED", showing: 1 },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
    ]);
    expect(isCelebrationSpent(spent)).toBe(true);

    // The server says it is owed again, with nothing in flight to make that
    // claim stale. The server wins.
    const fresh = celebrationReducer(spent, {
      type: "SERVER_MODEL_ARRIVED",
      model: serverModel(true),
    });
    expect(isCelebrationSpent(fresh)).toBe(false);
  });

  // Retiring suppression must not orphan a showing that is still on screen: the
  // confetti stays mounted, no further CELEBRATION_SHOWN fires, and a close that
  // recorded against showing 0 would be silently dropped.
  it("F: retiring suppression keeps the on-screen showing closable", () => {
    const retired = drive([
      ...showing(1),
      { type: "STAMP_SUCCEEDED", showing: 1 },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
    ]);
    expect(retired.live).not.toBe(0);
    const closedAgain = drive(
      [{ type: "STAMP_SUCCEEDED", showing: 1 }],
      celebrationReducer(retired, { type: "OWNER_CLOSED_AFTER_SHOWING" }),
    );
    expect(closedAgain.closed).toBe(retired.live);
  });

  // G. an incomplete studio never begins a showing, so nothing can be consumed
  it("G: with no showing, a close spends nothing", () => {
    const closed = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(false) },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
    ]);
    expect(closed.closed).toBe(0);
    expect(isCelebrationSpent(closed)).toBe(false);
  });
});

describe("celebration machine — what the client may never do", () => {
  it("never permanently spends a server-owed celebration after a refusal", () => {
    let state = drive([...showing(1)]);
    for (let n = 1; n <= 3; n += 1) {
      state = drive(
        [
          { type: "STAMP_REFUSED_OR_FAILED", showing: n },
          { type: "OWNER_CLOSED_AFTER_SHOWING" },
          { type: "OWNER_REOPENED" },
          ...showing(n + 1),
        ],
        state,
      );
      expect(isCelebrationSpent(state)).toBe(false);
    }
  });

  // The barrier that holds even when NO fresh model ever arrives to retire the
  // old close — the generation comparison alone.
  it("never lets an old close apply to a later distinct attempt", () => {
    const state = drive([
      ...showing(1),
      { type: "OWNER_CLOSED_AFTER_SHOWING" }, // close belongs to showing 1
      { type: "STAMP_REFUSED_OR_FAILED", showing: 1 },
      { type: "OWNER_REOPENED" },
      ...showing(2), // a distinct attempt
      { type: "STAMP_SUCCEEDED", showing: 2 },
    ]);
    expect(state.closed).not.toBe(state.stamped);
    expect(isCelebrationSpent(state)).toBe(false);
  });

  it("never discards a server model merely because it arrived during a request", () => {
    const during = drive([
      ...showing(1),
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
    ]);
    // Recorded as seen AND held for resolution — not one or the other.
    expect(during.seen).toBe(during.deferred);
    expect(during.deferred).not.toBeNull();
  });

  it("ignores a settlement belonging to a superseded showing", () => {
    const state = drive([
      ...showing(1),
      ...showing(2),
      { type: "STAMP_SUCCEEDED", showing: 1 },
    ]);
    expect(state.stamped).toBe(0);
    expect(state.inFlight).toBe(2);
  });

  it("treats a client-only re-render as saying nothing new", () => {
    const model = serverModel(true);
    const once = drive([
      ...showing(1),
      { type: "STAMP_SUCCEEDED", showing: 1 },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
      { type: "SERVER_MODEL_ARRIVED", model },
    ]);
    // The same prop object again must not retire anything a second time.
    expect(celebrationReducer(once, { type: "SERVER_MODEL_ARRIVED", model })).toBe(
      once,
    );
  });
});

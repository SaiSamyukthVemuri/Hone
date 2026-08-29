import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
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
// ANTI-VACUITY, against every earlier version — because three of them were
// wrong, and each was wrong in a way the previous controls did not catch.
//
// (1) The pre-repair wizard: a `stampInFlight` ref, a `lastModel` ref, and
//     `closedAfterShowing && stampConfirmed`. TEN of these 20 read red.
//
// (2) Machine v1, which resolved deferral but scoped the durable stamp to a
//     showing as well. FIVE read red for semantic reasons, chiefly:
//       * "retains a durable success from a superseded showing, without spending it"
//       * "a superseded FAILURE retracts nothing and clears nothing"
//       * "a durable stamp survives supersession and a later failure"
//     (Two more fail there only because v1 named the field `stamped`. Those are
//     rename artefacts, not discriminators, and are not counted as such.)
//
// (3) Machine v2, which let a deferred model retract a confirmed stamp. TWO
//     read red:
//       * "a deferred model cannot retract a success recorded while it waited"
//       * "a positive model arriving after a confirmed stamp retracts nothing"
//
// The controls that pass against every version are here to pin behaviour that
// was already correct, so a repair cannot regress it. Knowing which is which is
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
      ...showing(2), // 12, 13
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
    expect(settled.stampConfirmed).toBe(false);
    expect(isCelebrationSpent(settled)).toBe(false);

    // 12, 13: the owner reopens and the retry succeeds.
    const retried = drive(
      [
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
    // Spent, and reopening cannot un-spend it: the close belongs to the live
    // showing, and the durable stamp is not showing-scoped.
    expect(isCelebrationSpent(settled)).toBe(true);
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
    // Reopening cannot un-spend it: the close still belongs to the live showing.
    expect(isCelebrationSpent(closed)).toBe(true);
  });

  // B. show -> stamp refuses -> close -> positive model -> reopen -> offered again
  it("B: a refused stamp leaves the celebration owed", () => {
    const refused = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      ...showing(1),
      { type: "STAMP_REFUSED_OR_FAILED", showing: 1 },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
    ]);
    expect(refused.stampConfirmed).toBe(false);
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

  // F. a genuinely fresh positive model AFTER settlement regains authority.
  //
  // Scoped to the case where it can be authoritative: the stamp was REFUSED, so
  // nothing was written and a model reporting the celebration as owed is simply
  // correct. (After a CONFIRMED stamp the same model is provably stale — see the
  // monotonicity controls below.)
  it("F: after a refusal, a fresh positive model makes it eligible again", () => {
    const stuck = drive([
      ...showing(1),
      { type: "STAMP_REFUSED_OR_FAILED", showing: 1 },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
    ]);
    expect(stuck.closed).not.toBe(0);

    const fresh = celebrationReducer(stuck, {
      type: "SERVER_MODEL_ARRIVED",
      model: serverModel(true),
    });
    expect(fresh.closed).toBe(0);
    expect(isCelebrationSpent(fresh)).toBe(false);
  });

  // Retiring suppression must not orphan a showing that is still on screen: the
  // confetti stays mounted, no further CELEBRATION_SHOWN fires, and a close that
  // recorded against showing 0 would be silently dropped.
  it("F: retiring suppression keeps the on-screen showing closable", () => {
    const retired = drive([
      ...showing(1),
      { type: "STAMP_REFUSED_OR_FAILED", showing: 1 },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
    ]);
    expect(retired.closed).toBe(0);
    expect(retired.live).not.toBe(0);
    const closedAgain = celebrationReducer(retired, {
      type: "OWNER_CLOSED_AFTER_SHOWING",
    });
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
      ...showing(2), // a distinct attempt
      { type: "STAMP_SUCCEEDED", showing: 2 },
    ]);
    expect(state.closed).not.toBe(state.live);
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

  // A superseded settlement may not touch the request now outstanding — but a
  // SUCCESS is a durable fact about the studio, so it is still recorded. The
  // earlier version of this machine discarded it, and Codex was right that doing
  // so lets a later failing showing replay confetti the server had recorded.
  it("retains a durable success from a superseded showing, without spending it", () => {
    const state = drive([
      ...showing(1),
      ...showing(2), // showing 2 supersedes showing 1's request
      { type: "STAMP_SUCCEEDED", showing: 1 },
    ]);
    expect(state.stampConfirmed).toBe(true);
    // ...but it does not clear the CURRENT request, and cannot suppress showing
    // 2, which the owner has not closed.
    expect(state.inFlight).toBe(2);
    expect(isCelebrationSpent(state)).toBe(false);
  });

  it("a superseded FAILURE retracts nothing and clears nothing", () => {
    const state = drive([
      ...showing(1),
      { type: "STAMP_SUCCEEDED", showing: 1 },
      ...showing(2),
      { type: "STAMP_REFUSED_OR_FAILED", showing: 1 },
    ]);
    expect(state.stampConfirmed).toBe(true);
    expect(state.inFlight).toBe(2);
  });

  // Codex's finding on the first version of this machine, as a control.
  // Reopening while request 1 is still pending starts showing 2; request 1 then
  // succeeds (celebrated_at IS written) but is superseded; request 2 fails. The
  // durable write must survive all of that, so closing showing 2 spends it and
  // no later showing replays.
  it("a durable stamp survives supersession and a later failure", () => {
    const settled = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      ...showing(1),
      { type: "OWNER_CLOSED_AFTER_SHOWING" }, // closes showing 1
      ...showing(2), // reopened while request 1 is still pending
      { type: "STAMP_SUCCEEDED", showing: 1 }, // the write DID land
      { type: "STAMP_REFUSED_OR_FAILED", showing: 2 },
    ]);
    // Showing 2 is still owed to the owner: they have not closed it.
    expect(isCelebrationSpent(settled)).toBe(false);
    // Closing it spends the celebration for good, on the strength of the
    // durable stamp from the superseded request.
    const closed = celebrationReducer(settled, {
      type: "OWNER_CLOSED_AFTER_SHOWING",
    });
    expect(closed.stampConfirmed).toBe(true);
    expect(isCelebrationSpent(closed)).toBe(true);
  });

  // Codex's finding on the second version of this machine.
  //
  // A positive model read before showing 1's stamp committed, but arriving after
  // showing 2 started, was held as `deferred`; when showing 2 then FAILED, the
  // machine applied it and cleared the `stampConfirmed` that showing 1's success
  // had just recorded. The server never retracted `celebrated_at`, so closing and
  // reopening showing 2 replayed the celebration.
  it("a deferred model cannot retract a success recorded while it waited", () => {
    const settled = drive([
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      ...showing(1),
      ...showing(2), // showing 2 supersedes showing 1's request
      // Read before showing 1 committed, delivered after showing 2 started.
      { type: "SERVER_MODEL_ARRIVED", model: serverModel(true) },
      { type: "STAMP_SUCCEEDED", showing: 1 }, // the write DID land
      { type: "STAMP_REFUSED_OR_FAILED", showing: 2 },
    ]);
    expect(settled.stampConfirmed).toBe(true);
    const closed = celebrationReducer(settled, {
      type: "OWNER_CLOSED_AFTER_SHOWING",
    });
    expect(isCelebrationSpent(closed)).toBe(true);
  });

  // The same rule stated directly, and the reason it is a property of the FACT
  // rather than of the timing: `celebrated_at` is stamp-once on a protected
  // field and never returns to null, so a model reporting the celebration as
  // owed was necessarily read BEFORE the write, whenever it arrives.
  it("a positive model arriving after a confirmed stamp retracts nothing", () => {
    const spent = drive([
      ...showing(1),
      { type: "STAMP_SUCCEEDED", showing: 1 },
      { type: "OWNER_CLOSED_AFTER_SHOWING" },
    ]);
    expect(isCelebrationSpent(spent)).toBe(true);

    const after = celebrationReducer(spent, {
      type: "SERVER_MODEL_ARRIVED",
      model: serverModel(true),
    });
    expect(after.stampConfirmed).toBe(true);
    expect(after.closed).toBe(spent.closed);
    expect(isCelebrationSpent(after)).toBe(true);
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

// ---------------------------------------------------------------------------
// THE PREMISE THE MACHINE RESTS ON
// ---------------------------------------------------------------------------
// `retire` refuses to retract `stampConfirmed` because `celebrated_at` is
// MONOTONIC: a model reporting the celebration as owed must therefore predate
// the write. That is an argument about the DATABASE, made in a client file, so
// it is pinned here rather than left as prose. If a future migration ever clears
// or re-stamps the field, this fails and the machine's rule has to be revisited
// — which is the whole point of writing it down.
describe("celebration machine — the durable premise", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const migrationsDir = path.join(ROOT, "supabase/migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => [f, readFileSync(path.join(migrationsDir, f), "utf8")] as const);

  it("finds the migrations, so this guard cannot pass vacuously", () => {
    expect(migrations.length).toBeGreaterThan(100);
    expect(
      migrations.filter(([, sql]) => /celebrated_at/.test(sql)).length,
    ).toBeGreaterThan(0);
  });

  it("no migration ever clears or re-stamps celebrated_at", () => {
    for (const [file, sql] of migrations) {
      // Every assignment to the column, anywhere in the schema.
      const assignments =
        sql.match(/celebrated_at\s*=\s*(?:now\(\)|[^\s;,)]+)/g) ?? [];
      for (const a of assignments) {
        // `celebrated_at = now()` is the stamp; `= null` would be a reset, and
        // `is null` is a read used by the compare-and-set, not an assignment.
        expect(a, `${file}: ${a}`).toMatch(/celebrated_at\s*=\s*now\(\)/);
      }
    }
  });

  it("the only writer is a stamp-once compare-and-set", () => {
    const withStamp = migrations.filter(([, sql]) =>
      /celebrated_at\s*=\s*now\(\)/.test(sql),
    );
    expect(withStamp.length).toBe(1);
    const [, sql] = withStamp[0];
    // The CAS guard is what makes the stamp once-only: an existing timestamp is
    // never overwritten, so the value cannot move backwards or forwards again.
    expect(sql).toMatch(/where\s+so\.celebrated_at\s+is\s+null/i);
  });

  it("no application code writes the column at all", () => {
    const roots = ["app", "lib", "components"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) {
          const body = readFileSync(full, "utf8");
          if (/celebrated_at\s*=(?!=)/.test(body)) {
            offenders.push(path.relative(ROOT, full));
          }
        }
      }
    };
    for (const r of roots) walk(path.join(ROOT, r));
    expect(offenders).toEqual([]);
  });
});

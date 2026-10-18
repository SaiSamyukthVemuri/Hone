import { describe, expect, it } from "vitest";

import {
  addGroup,
  firstGroup,
  highestOrdinal,
  recordedGroupsMoved,
} from "@/lib/machines/setting-groups";

// ===========================================================================
// TWO TABS MUST NOT MERGE TWO PROBE SETS INTO ONE TIMELINE
// (Codex, #860 4305780322)
// ===========================================================================
//
// A form mints its next group identity from the recorded snapshot it loaded:
// `highestOrdinal` over exactly that set. So two page loads that both add a
// group both pick the SAME next key — and `record_setup_group_in_scope` takes
// the second as the next REVISION of the first. Two distinct probe sets merge
// into one group's history, and only the second one's values read as current:
// a silent loss of what she recorded first.
//
// `addGroup`'s own comment already described this outcome for a sibling case
// (reissuing a removed identity) and said it "happens to be unreachable today
// ... That is one guard away from a corrupt clinical record, which is not
// where this invariant should live." The monotonic counter it chose protects
// ONE form instance. This is the case it cannot see.
//
// WHAT IS PROVED HERE is the detection rule. Durable allocation of the
// identity is the real fix, belongs to the command, and is deferred with the
// reader RPC — both are 0223 edits and land together.
// ===========================================================================

describe("the second tab's collision, step by step", () => {
  it("both tabs independently derive the SAME next identity", () => {
    // The setup as it actually happens: one recorded group, two page loads.
    const recorded = ["g1"];
    const tabOneDraft = recorded.map((id) => ({ id, channels: [], values: {} }));
    const tabTwoDraft = recorded.map((id) => ({ id, channels: [], values: {} }));

    // Each tab adds a group, each counting from its own snapshot.
    const tabOne = addGroup(tabOneDraft, highestOrdinal(tabOneDraft) + 1);
    const tabTwo = addGroup(tabTwoDraft, highestOrdinal(tabTwoDraft) + 1);

    expect(tabOne.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(
      tabTwo.map((g) => g.id),
      "the two tabs minted different identities, so there is nothing to guard",
    ).toEqual(["g1", "g2"]);
  });

  it("so after the first tab saves, the second tab's save is REFUSED", () => {
    // Tab two built its draft when only g1 existed.
    const tabTwoExpected = ["g1"];
    // Tab one has since committed its g2.
    const nowRecorded = ["g1", "g2"];

    expect(
      recordedGroupsMoved(tabTwoExpected, nowRecorded),
      "tab two's save would have filed its g2 as a REVISION of tab one's",
    ).toBe(true);
  });

  it("and the empty-setup case collides the same way on g1", () => {
    // The finding names this variant explicitly: with nothing recorded, both
    // tabs mint `g1`.
    const tabOne = firstGroup();
    const tabTwo = firstGroup();
    expect(tabOne[0]!.id).toBe("g1");
    expect(tabTwo[0]!.id).toBe("g1");
    expect(recordedGroupsMoved([], ["g1"])).toBe(true);
  });

  it("CONTROL: an UNCHANGED set is not refused", () => {
    // Without this the rule would also pass if it refused everything, which
    // would block every ordinary save.
    expect(recordedGroupsMoved(["g1"], ["g1"])).toBe(false);
    expect(recordedGroupsMoved([], [])).toBe(false);
    expect(recordedGroupsMoved(["g1", "g2"], ["g1", "g2"])).toBe(false);
  });

  it("CONTROL: order and duplicates are not changes", () => {
    // Neither is a fact about the record. Treating them as movement would
    // refuse saves that are fine, and a guard that cries wolf gets disabled.
    expect(recordedGroupsMoved(["g2", "g1"], ["g1", "g2"])).toBe(false);
    expect(recordedGroupsMoved(["g1", "g1"], ["g1"])).toBe(false);
  });

  it("a REMOVED group counts as movement too", () => {
    // Not the reported case, but the same hazard in reverse: the snapshot the
    // draft reasoned from is gone, so its identity arithmetic is no longer
    // sound.
    expect(recordedGroupsMoved(["g1", "g2"], ["g1"])).toBe(true);
  });

  it("a RENAMED-SET of the same size is movement", () => {
    // Equal lengths must not be mistaken for equal sets — the cheap
    // implementation of this rule is a length comparison, and it would miss
    // exactly this.
    expect(recordedGroupsMoved(["g1", "g2"], ["g1", "g3"])).toBe(true);
  });
});

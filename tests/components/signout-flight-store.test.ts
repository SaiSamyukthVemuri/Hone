import { beforeEach, describe, expect, it } from "vitest";

import {
  adoptSignOut,
  claimSignOut,
  isSignOutClaimOrphaned,
  orphanSignOut,
  releaseSignOut,
  setSignOutInFlight,
  __resetSignOutInFlightForTests,
} from "@/app/(app)/signout-flight";

// SIGNOUT-02c · the claim lifecycle, exercised directly.
//
// The browser lane proves the OUTCOMES — neither shell offers a second logout
// across a breakpoint crossing, both restore afterwards. This proves the rule
// that produces them, including the transition a browser test reaches only by
// driving history out of the route group and back.

beforeEach(() => {
  __resetSignOutInFlightForTests();
});

describe("SIGNOUT-02c · a hold is only released by someone who can see the action", () => {
  it("an ordinary logout claims and releases", () => {
    setSignOutInFlight(true);
    expect(isSignOutClaimOrphaned(), "a live claim is not orphaned").toBe(false);
    setSignOutInFlight(false);
    expect(isSignOutClaimOrphaned()).toBe(false);
  });

  it("a leaf that unmounts mid-flight ORPHANS the hold rather than dropping it", () => {
    // The other shell must not open up merely because a panel was taken down.
    claimSignOut();
    orphanSignOut();
    expect(
      isSignOutClaimOrphaned(),
      "the hold was dropped when its owner went away",
    ).toBe(true);
  });

  it("orphaning does nothing when no hold is standing", () => {
    orphanSignOut();
    expect(isSignOutClaimOrphaned()).toBe(false);
  });

  it("a NEW leaf adopts — and ends — an unowned hold", () => {
    // THE DEFECT THIS EXISTS FOR. Module scope outlives the component tree, so
    // leaving the (app) route group mid-logout used to strand the flag with
    // nothing able to clear it: Sign out and every destination stayed disabled
    // for a request that had already finished.
    claimSignOut();
    orphanSignOut();
    adoptSignOut();
    expect(isSignOutClaimOrphaned()).toBe(false);
    // And the hold really is gone, not merely un-orphaned: a fresh orphan()
    // has nothing to act on.
    orphanSignOut();
    expect(
      isSignOutClaimOrphaned(),
      "adopt left a hold standing that nobody owns",
    ).toBe(false);
  });

  it("adopting does NOT touch a hold that still has an owner", () => {
    // The dangerous direction. A leaf mounting while another leaf is actively
    // watching a live action must change nothing, or the second shell opens up
    // mid-logout and the whole slice is undone.
    claimSignOut();
    adoptSignOut();
    expect(isSignOutClaimOrphaned()).toBe(false);
    // Still held: orphaning it is still meaningful, which it would not be if
    // adopt had cleared the claim.
    orphanSignOut();
    expect(
      isSignOutClaimOrphaned(),
      "adopt released a live hold whose owner was still watching",
    ).toBe(true);
  });

  it("re-claiming re-owns an orphaned hold", () => {
    // A leaf that mounts and then genuinely goes pending owns it again.
    claimSignOut();
    orphanSignOut();
    claimSignOut();
    expect(isSignOutClaimOrphaned()).toBe(false);
  });

});

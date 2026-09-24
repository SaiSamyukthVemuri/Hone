import { beforeEach, describe, expect, it } from "vitest";

import {
  isSignOutInFlight,
  setSignOutInFlight,
  __resetSignOutInFlightForTests,
} from "@/app/(app)/signout-flight";

// SIGNOUT-02c · the shared hold, and why it is COUNTED.
//
// The browser lane proves the outcomes: neither shell offers a second logout
// across a breakpoint crossing, no destination is navigable while pending,
// exactly one request reaches the wire. This proves the arithmetic underneath,
// which the browser cannot easily stage — both shells host a persistent
// sign-out form, so TWO reporters can publish into this one flag.

beforeEach(() => {
  __resetSignOutInFlightForTests();
});

describe("SIGNOUT-02c · one hold, published by either shell", () => {
  it("a single logout raises and lowers it", () => {
    setSignOutInFlight(true);
    expect(isSignOutInFlight()).toBe(true);
    setSignOutInFlight(false);
    expect(isSignOutInFlight()).toBe(false);
  });

  it("a second reporter settling cannot lower a first that is still running", () => {
    // THE REASON IT IS A COUNT. Both shells are always mounted and each hosts
    // its own form and reporter. A boolean would let whichever settled first
    // open both menus while the other request was still in flight.
    setSignOutInFlight(true);
    setSignOutInFlight(true);
    setSignOutInFlight(false);
    expect(
      isSignOutInFlight(),
      "one reporter's ending released a hold another was still holding",
    ).toBe(true);
    setSignOutInFlight(false);
    expect(isSignOutInFlight()).toBe(false);
  });

  it("never goes negative, so a stray release cannot poison the next logout", () => {
    // A reporter unmounting after it already published `false` would otherwise
    // drive the count below zero, and the NEXT logout would raise it only back
    // to zero — held by nothing, and invisible.
    setSignOutInFlight(false);
    setSignOutInFlight(false);
    expect(isSignOutInFlight()).toBe(false);

    setSignOutInFlight(true);
    expect(
      isSignOutInFlight(),
      "a stray release left the counter below zero and swallowed the next hold",
    ).toBe(true);
  });
});

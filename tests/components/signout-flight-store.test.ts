import { beforeEach, describe, expect, it } from "vitest";

import {
  isSignOutInFlight,
  trackSignOut,
  __resetSignOutInFlightForTests,
} from "@/app/(app)/signout-flight";

// SIGNOUT-02c · the hold belongs to the ACTION, and to nothing else.
//
// The browser lane proves what a practitioner can see: neither shell offers a
// second logout across a breakpoint crossing, no destination is navigable
// while held, exactly one request reaches the wire, and the controls come back
// afterwards. This proves the property those all rest on, against promises the
// test itself controls — so "still in flight" and "settled" are facts rather
// than timing.
//
// THE POINT OF EVERY CASE HERE IS THE SAME: there is no way to release the
// hold except by settling the request. The module exports no release, no
// claim, no adopt, and no cleanup hook — a component disappearing has nothing
// to call.

beforeEach(() => {
  __resetSignOutInFlightForTests();
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SIGNOUT-02c · only real settlement releases the hold", () => {
  it("is held from the moment the action starts", () => {
    const d = deferred();
    void trackSignOut(() => d.promise);
    expect(isSignOutInFlight()).toBe(true);
    d.resolve();
  });

  it("survives everything that is not the request settling", async () => {
    // Cases 1-4 of the contract, as one property. A submit control
    // unmounting, a shell unmounting, a breakpoint swap, leaving the route
    // group and coming back — none of them can reach this hold, because the
    // module gives them nothing to reach it WITH. The only lever is the
    // promise, and it has not settled.
    const d = deferred();
    void trackSignOut(() => d.promise);

    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));

    expect(
      isSignOutInFlight(),
      "the hold ended without the request settling",
    ).toBe(true);
    d.resolve();
  });

  it("releases when the request settles with nothing mounted", async () => {
    // Case 5. Nothing component-shaped exists in this context at all, which is
    // precisely the state after the shell has gone — and the `finally` does
    // not care, because it is attached to the promise rather than to a tree.
    const d = deferred();
    const tracked = trackSignOut(() => d.promise);
    expect(isSignOutInFlight()).toBe(true);

    d.resolve();
    await tracked;

    expect(
      isSignOutInFlight(),
      "the hold outlived a request that had already settled",
    ).toBe(false);
  });

  it("releases on a FAILED request, and lets the error through", async () => {
    // A logout that fails must leave the practitioner able to try again, and
    // the failure must not be swallowed: `signOut()` ends in `redirect()`,
    // whose throw is how the navigation happens at all.
    const d = deferred();
    const tracked = trackSignOut(() => d.promise);
    const boom = new Error("provider refused");
    d.reject(boom);

    await expect(tracked).rejects.toBe(boom);
    expect(isSignOutInFlight(), "a failed request left the hold standing").toBe(false);
  });

  it("hands back the action's OWN promise, not a wrapper around it", async () => {
    // Load-bearing rather than stylistic. An `async` wrapper returns a NEW
    // promise built by awaiting the action; returning the original leaves what
    // React receives byte-for-byte unchanged, redirect throw included.
    const d = deferred();
    const returned = trackSignOut(() => d.promise);
    expect(returned).toBe(d.promise);
    d.resolve();
    await returned;
  });

  it("an overlapping request settling first cannot release the other", async () => {
    // Counted, not boolean. The duplicate guards make this unreachable in the
    // product; the counter means the module does not depend on them being
    // perfect.
    const first = deferred();
    const second = deferred();
    const a = trackSignOut(() => first.promise);
    const b = trackSignOut(() => second.promise);

    second.resolve();
    await b;
    expect(
      isSignOutInFlight(),
      "one request's ending released a hold the other was still holding",
    ).toBe(true);

    first.resolve();
    await a;
    expect(isSignOutInFlight()).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  isSignOutInFlight,
  trackSignOut,
  __resetSignOutInFlightForTests,
} from "@/app/(app)/signout-flight";

// SIGNOUT-02c · the hold belongs to the ACTION, and clears only when it settles.
//
// The browser lane proves the outcomes — neither shell offers a second logout
// across a breakpoint crossing, no destination is navigable while pending,
// exactly one request reaches the wire. This proves the property those rest on
// and that a browser cannot easily stage: the flag's lifetime is the REQUEST's
// lifetime, not any component's.
//
// Every case here drives a promise the test itself controls, so "still in
// flight" and "settled" are facts rather than timing.

beforeEach(() => {
  __resetSignOutInFlightForTests();
});

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SIGNOUT-02c · the hold lasts exactly as long as the request", () => {
  it("goes up as soon as the action starts", () => {
    const d = deferred();
    void trackSignOut(() => d.promise);
    expect(isSignOutInFlight()).toBe(true);
    d.resolve();
  });

  it("1 + 2. survives anything that is not the request settling", async () => {
    // The two mutations that killed earlier revisions, stated as one property.
    // A leaf unmounting, a leaf REMOUNTING, a shell being revealed or hidden —
    // none of them touch this module, because none of them is the action. The
    // store exposes no way for them to.
    const d = deferred();
    void trackSignOut(() => d.promise);

    // Whatever a component might do, it cannot lower the flag: there is no
    // release, claim, orphan or adopt to call. The only lever is the promise.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(
      isSignOutInFlight(),
      "the hold ended without the request settling",
    ).toBe(true);

    d.resolve();
    await Promise.resolve();
  });

  it("3. clears on a true settlement", async () => {
    const d = deferred();
    const tracked = trackSignOut(() => d.promise);
    expect(isSignOutInFlight()).toBe(true);
    d.resolve();
    await tracked;
    expect(isSignOutInFlight(), "a settled request left the hold standing").toBe(false);
  });

  it("4. clears when the request settles AFTER its shell is gone", async () => {
    // The defect a bare module boolean created: the submit leaf and the whole
    // route group can be unmounted while the request runs, and then nothing
    // component-shaped is left to report the ending. The `finally` does not
    // care — it is attached to the promise, not to a tree.
    const d = deferred();
    const tracked = trackSignOut(() => d.promise);

    // "The shell is gone" is the default here, not something to simulate: no
    // component is mounted in this context, so nothing is subscribed and
    // nothing component-shaped exists to report the ending.
    expect(isSignOutInFlight()).toBe(true);

    d.resolve();
    await tracked;
    expect(
      isSignOutInFlight(),
      "the hold outlived a request that had already settled",
    ).toBe(false);
  });

  it("clears on a FAILED request too, and lets the error through", async () => {
    // A logout that fails must leave the practitioner able to try again, and
    // the failure itself must not be swallowed — `signOut()` ends in
    // `redirect()`, whose throw is how the navigation happens at all.
    const d = deferred();
    const tracked = trackSignOut(() => d.promise);
    const boom = new Error("provider refused");
    d.reject(boom);
    await expect(tracked).rejects.toBe(boom);
    expect(isSignOutInFlight(), "a failed request left the hold standing").toBe(false);
  });

  it("overlapping requests cannot lower the flag early", async () => {
    // Counted rather than boolean: a second call finishing first must not
    // release a first that is still running. The duplicate guards make this
    // unreachable in the product; the counter means this module does not
    // depend on them being perfect.
    const first = deferred();
    const second = deferred();
    const a = trackSignOut(() => first.promise);
    const b = trackSignOut(() => second.promise);

    second.resolve();
    await b;
    expect(
      isSignOutInFlight(),
      "the second request's ending released the first one's hold",
    ).toBe(true);

    first.resolve();
    await a;
    expect(isSignOutInFlight()).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { createSignOutFlight } from "@/app/(app)/signout-flight";

// SIGNOUT-02c · the shared hold — why it is COUNTED, and why it is PER-MOUNT.
//
// The browser lane proves what a practitioner can see: neither shell offers a
// second logout across a breakpoint crossing, no destination is navigable
// while held, exactly one request reaches the wire, and the controls come back
// afterwards. This proves the two properties underneath, which the browser
// cannot easily stage — both shells host a persistent sign-out form, so TWO
// reporters can publish into one hold; and a hold belongs to the shell that
// can still report on it.

describe("SIGNOUT-02c · one hold, published by either shell", () => {
  it("a single logout raises and lowers it", () => {
    const flight = createSignOutFlight();
    flight.set(true);
    expect(flight.get()).toBe(true);
    flight.set(false);
    expect(flight.get()).toBe(false);
  });

  it("a second reporter settling cannot lower a first that is still running", () => {
    // THE REASON IT IS A COUNT. Both shells are always mounted and each hosts
    // its own form and reporter. A boolean would let whichever settled first
    // open both menus while the other request was still in flight.
    const flight = createSignOutFlight();
    flight.set(true);
    flight.set(true);
    flight.set(false);
    expect(
      flight.get(),
      "one reporter's ending released a hold another was still holding",
    ).toBe(true);
    flight.set(false);
    expect(flight.get()).toBe(false);
  });

  it("never goes negative, so a stray release cannot swallow the next hold", () => {
    const flight = createSignOutFlight();
    flight.set(false);
    flight.set(false);
    expect(flight.get()).toBe(false);

    flight.set(true);
    expect(
      flight.get(),
      "a stray release left the counter below zero and swallowed the next hold",
    ).toBe(true);
  });

  it("publishes every change to its subscribers", () => {
    // `useSignOutInFlight` is a `useSyncExternalStore` over this, so a change
    // that does not notify is a menu that never updates.
    const flight = createSignOutFlight();
    let notifications = 0;
    const unsubscribe = flight.subscribe(() => {
      notifications += 1;
    });

    flight.set(true);
    flight.set(false);
    expect(notifications, "a change was not published to subscribers").toBe(2);

    unsubscribe();
    flight.set(true);
    expect(notifications, "a change was published after unsubscribing").toBe(2);
  });
});

describe("SIGNOUT-02c · a hold cannot outlive the shell that can release it", () => {
  it("a NEW shell's hold starts clear while an old one is still held", () => {
    // THE DEFECT THIS CLOSES, and the reason the hold is not module state.
    //
    // Only a `SignOutFlightReporter` inside a mounted sign-out form can observe
    // a settlement — `useFormStatus` reports for the form its caller runs
    // inside. So if the whole `(app)` group unmounts while a logout is in
    // flight, the settlement can never be reported by anyone.
    //
    // With the count at module scope, that hold SURVIVED the unmount: returning
    // into the group in the same document rendered a fresh shell reading a hold
    // nothing left alive could ever clear, and every menu was disabled for the
    // rest of the document's life.
    //
    // A store per provider mount puts the authority's lifetime on the
    // observer's. This is not "unmount means settled" — the stranded hold is
    // not released, it is GONE along with the controls it was holding.
    const stranded = createSignOutFlight();
    stranded.set(true);
    expect(stranded.get(), "precondition: the old shell is holding").toBe(true);

    const returned = createSignOutFlight();
    expect(
      returned.get(),
      "a shell that never submitted anything inherited a hold it can never clear — its menus are disabled for good",
    ).toBe(false);
  });

  it("neither shell's holds can reach the other", () => {
    // Both directions, so the isolation is not one-way by accident.
    const first = createSignOutFlight();
    const second = createSignOutFlight();

    first.set(true);
    expect(second.get(), "a hold leaked forwards into a later shell").toBe(false);

    second.set(true);
    first.set(false);
    expect(
      second.get(),
      "a stranded shell's release lowered a hold a live shell was still holding",
    ).toBe(true);
  });

  it("a stranded shell's subscribers are not notified by a live one", () => {
    // The listener sets, too: a leaked subscription would re-render a tree that
    // is no longer on the page.
    const stranded = createSignOutFlight();
    let strandedNotifications = 0;
    stranded.subscribe(() => {
      strandedNotifications += 1;
    });

    const live = createSignOutFlight();
    live.set(true);
    expect(
      strandedNotifications,
      "a live shell's change notified a stranded shell's subscriber",
    ).toBe(0);
  });
});

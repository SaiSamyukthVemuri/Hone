"use client";

import { useSyncExternalStore } from "react";

// SIGNOUT-02c · ONE logout-in-flight hold, shared by both responsive shells.
//
// THE DEFECT THIS CLOSES. `app/(app)/layout.tsx` renders BOTH menus on every
// page and hides one with CSS — `hidden … lg:flex` for the desktop account
// menu, `… lg:hidden` for the phone sheet. They are always-mounted siblings,
// so a per-shell `useState` made the flag per-SHELL rather than
// per-practitioner: crossing the `lg` breakpoint mid-logout revealed the other
// menu with its own flag still false, and a fresh enabled Sign out with it.
//
// WHO WRITES IT. A `SignOutFlightReporter` inside each shell's persistent
// sign-out form, via `useFormStatus`. The form sits outside the `{open && …}`
// panel, so closing the panel, crossing the breakpoint or holding a link
// cannot unmount the observer.
//
// WHY THE FORM'S ACTION IS THE SERVER ACTION AND NOTHING ELSE. A previous
// revision gave the hold to the action's own promise by passing a client
// function as the form's action — `action={() => trackSignOut(signOut)}`. That
// owned the request's lifetime properly, and it broke two things that matter
// more, both MEASURED rather than argued:
//
//   * PROGRESSIVE ENHANCEMENT. React then renders
//     `action="javascript:throw new Error('React form unexpectedly
//     submitted.')"` with no endpoint and no `$ACTION_ID_` field, so a press
//     before hydration, or with JS disabled, signs nobody out. With the server
//     action it renders a real POST target — which is the contract
//     `recordSignOutTraffic`'s "progressive-enhancement form body" path
//     already depends on.
//   * THE SOFT REDIRECT. Next stops routing the action's redirect, so /login
//     becomes a hard browser navigation that tears down in-flight prefetches.
//
// Tracking is therefore layered ON the native submission, never in place of it.
//
// THE RESIDUAL THIS LEAVES, stated plainly rather than traded away. The
// observer is a component, so it cannot report a settlement that happens after
// the whole `(app)` route group has unmounted — reachable only through browser
// history, since every menu destination is held while a logout is in flight.
// In that case the hold persists until the document is replaced. It is NOT
// released from unmount cleanup: a component going away is not evidence that
// the request ended, and releasing there previously allowed a second logout to
// be submitted while the first was still running. Of the two, a hold that
// outlives its request is the safer failure, and the practitioner's session is
// already destroyed by then, so the next request redirects them to /login
// anyway.
//
// DOCUMENT-SCOPED, deliberately. Per-tab is the correct scope: a second
// document is a different browsing context, handled by the separate rule that
// holds every menu destination while a logout is in flight.

let inFlight = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Publish a transition seen by a reporter inside a persistent sign-out form.
 *
 * COUNTED and floored: both shells host a form and a reporter, so two can
 * publish, and neither a second one settling nor a stray release may lower a
 * hold the other still holds.
 */
export function setSignOutInFlight(next: boolean): void {
  inFlight += next ? 1 : -1;
  if (inFlight < 0) inFlight = 0;
  emit();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): boolean {
  return inFlight > 0;
}

// The server never has a logout in flight, and this must be a STABLE value
// rather than a fresh one per call, or React re-renders forever.
function getServerSnapshot(): boolean {
  return false;
}

/** Subscribe to the shared hold. Both shells call this and see one answer. */
export function useSignOutInFlight(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The same answer, for callers that are not React components. */
export function isSignOutInFlight(): boolean {
  return inFlight > 0;
}

/**
 * TEST SEAM ONLY. Resets the module state between cases in the unit lane,
 * where it would otherwise leak across tests in one worker. Never called by
 * the product.
 */
export function __resetSignOutInFlightForTests(): void {
  inFlight = 0;
  listeners.clear();
}

"use client";

import { useSyncExternalStore } from "react";

// SIGNOUT-02c · ONE logout-in-flight authority, owned by the ACTION itself.
//
// WHAT HAS TO BE TRUE. Exactly one thing must know that a logout started, that
// it is still running, and that it really finished — and that thing has to
// outlive everything the practitioner can dismantle while it runs: the open
// panel, the submit leaf inside it, the responsive shell that happens to be
// visible, and the `(app)` route group itself.
//
// THE ONLY THING WITH THAT LIFETIME IS THE ACTION'S OWN PROMISE. So the promise
// is the owner, and this module just holds the flag it drives. `trackSignOut`
// wraps the call: the flag goes up before it starts and comes down in a
// `finally`, which runs when the request genuinely settles — success, failure,
// or the redirect throw — and keeps running after every React component
// involved has unmounted, because a promise does not care about a component
// tree.
//
// SETTLEMENT IS NEVER INFERRED. Not from a leaf remounting, not from an
// orphaned claim, not from which shell is on screen, not from navigation, and
// not from elapsed time. Three earlier revisions each inferred it a different
// way and each one was wrong in its own direction:
//
//   * per-shell `useState` — crossing the `lg` breakpoint revealed the other
//     menu with its own flag still false, and a second enabled Sign out;
//   * a bare module boolean — leaving the route group unmounted the only
//     reporter, stranding the flag with nothing able to clear it;
//   * claim / orphan / adopt — a new leaf mounting ENDED the hold, which meant
//     returning mid-logout reopened both shells while the first request was
//     still running. That traded the stranded state for a live-request hole.
//
// The promise has none of those failure modes because it is not a proxy for
// the action. It IS the action.
//
// DOCUMENT-SCOPED, deliberately. This is per-tab state, which is the correct
// scope: a second document is a different browsing context, and is handled by
// the separate rule that holds every menu destination while a logout is in
// flight so no link can open one.

let inFlight = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Run a logout and own its lifetime.
 *
 * COUNTED, not a boolean, so the flag can never be lowered by a second
 * overlapping call finishing first. In practice the duplicate guards make a
 * second call unreachable; the counter means this module does not depend on
 * them being perfect.
 *
 * NOTHING IS CAUGHT HERE. `signOut()` ends in `redirect()`, which throws the
 * framework's redirect signal; swallowing it would strand the practitioner on
 * a page whose session no longer exists. `finally` lowers the flag and the
 * throw continues to React untouched.
 */
export function trackSignOut(run: () => Promise<void>): Promise<void> {
  inFlight += 1;
  emit();
  const running = run();
  // OBSERVE the promise; do not REPLACE it. An `async` wrapper here returns a
  // NEW promise built by awaiting the action, and React's action runtime then
  // handled the redirect differently — measured: the soft RSC navigation to
  // /login became a HARD browser navigation, which tore down every in-flight
  // prefetch and surfaced as "Failed to fetch RSC payload" across five
  // SIGNOUT-01 cases whose logouts were otherwise perfect.
  //
  // Attaching a settlement handler and returning the ORIGINAL promise leaves
  // what React sees byte-for-byte unchanged, including the redirect throw.
  running.then(settled, settled);
  return running;
}

function settled(): void {
  inFlight -= 1;
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

/** Subscribe to the shared flag. Both shells call this and see one answer. */
export function useSignOutInFlight(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The same answer, for callers that are not React components. */
export function isSignOutInFlight(): boolean {
  return inFlight > 0;
}

/**
 * TEST SEAM ONLY. Resets the module state between cases in the unit lane, where
 * it would otherwise leak across tests in one worker. Never called by the
 * product.
 */
export function __resetSignOutInFlightForTests(): void {
  inFlight = 0;
  listeners.clear();
}

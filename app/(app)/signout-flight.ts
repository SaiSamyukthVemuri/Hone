"use client";

import { useSyncExternalStore } from "react";

// SIGNOUT-02c · the hold belongs to the LOGOUT ACTION, and to nothing else.
//
// THE INVARIANT, stated once because four revisions each broke a different
// half of it: once a logout begins, the hold must survive the submit control
// unmounting, either menu shell unmounting, a responsive shell swap, leaving
// the `(app)` route group, and returning before the request settles. No
// component disappearing may release it. The only normal release authority is
// the real action settling.
//
// THAT RULES OUT EVERY COMPONENT-SHAPED OWNER, which is what the earlier
// revisions kept reaching for:
//
//   * per-shell useState        — crossing `lg` revealed the other menu with
//     its own flag false, and a second enabled Sign out;
//   * a bare module boolean     — leaving the route group unmounted the only
//     reporter and stranded the flag forever;
//   * claim / orphan / adopt    — a new leaf MOUNTING ended the hold, so
//     returning mid-logout reopened both shells while the request ran;
//   * a persistent-form reporter with unmount cleanup — better placed, but its
//     cleanup still released the hold because a COMPONENT went away, which is
//     the same mistake wearing a longer lifetime.
//
// The action's own promise is the only thing whose lifetime IS the request's,
// so it owns the hold: raised before the call, lowered in a `finally` that
// runs on success, on failure, and on the redirect throw — and keeps running
// after every component involved has unmounted, because a promise does not
// care about a component tree.
//
// Observers may subscribe and unsubscribe freely. They cannot write.
//
// IF THE REDIRECT DESTROYS THE DOCUMENT, normal teardown ends this naturally —
// module state dies with the document. If the document survives, only true
// settlement clears it.
//
// THE COST, measured and accepted. Passing a client function as the form's
// action makes Next stop routing the action's redirect: the soft RSC
// navigation to /login becomes a hard browser navigation. That is a real
// change and it is the price of owning the promise at all — both wrapper
// shapes were tried (awaiting, and returning the original promise untouched)
// with identical results, so it is the client function itself, not how the
// promise is handled inside it. e2e/signout-session-destruction.spec.ts
// records what that navigation does to in-flight prefetches, and suppresses
// exactly those two browser-attributed classes while still printing them.

let inFlight = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Run a logout and own its hold for the whole of its lifetime.
 *
 * COUNTED, so an overlapping call settling first cannot lower a hold an
 * earlier one still holds. The duplicate guards make that unreachable; the
 * counter means this module does not depend on them being perfect.
 *
 * NOTHING IS CAUGHT. `signOut()` ends in `redirect()`, which throws the
 * framework's redirect signal; swallowing it would strand the practitioner on
 * a page whose session no longer exists.
 */
export function trackSignOut(run: () => Promise<void>): Promise<void> {
  inFlight += 1;
  emit();
  const running = run();
  running.then(settled, settled);
  return running;
}

function settled(): void {
  inFlight -= 1;
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
 * TEST SEAM ONLY. Resets the module state between cases in the unit lane, where
 * it would otherwise leak across tests in one worker. Never called by the
 * product.
 */
export function __resetSignOutInFlightForTests(): void {
  inFlight = 0;
  listeners.clear();
}

"use client";

import { useSyncExternalStore } from "react";

// SIGNOUT-02c · ONE logout-in-flight authority, shared by both responsive shells.
//
// THE DEFECT THIS CLOSES. `app/(app)/layout.tsx` renders BOTH menus on every
// page and hides one with CSS — `hidden … lg:flex` for the desktop account
// menu, `… lg:hidden` for the phone sheet. They are siblings that are always
// mounted, so when each owned its own `signingOut` useState the flag was
// per-shell rather than per-practitioner: crossing the `lg` breakpoint
// mid-logout revealed the other menu with its own flag still false, and a
// fresh enabled Sign out with it.
//
// WHO OWNS IT NOW. Not this module, and not any menu panel: the `<form>` lives
// in the PERSISTENT part of each shell, outside the `{open && …}` panel, and a
// `useFormStatus` reporter inside that form publishes here. The form cannot be
// taken down by dismissing a panel, crossing a breakpoint, or holding a link,
// so its status is a faithful account of the action for as long as the shell
// exists.
//
// WHY THE FORM WAS NOT WRAPPED IN A CLIENT FUNCTION, which was the obvious
// route to "own the promise" and is MEASURED to be wrong here. Passing
// `action={() => trackSignOut(signOut)}` makes the form's action a client
// function, and Next then stops applying the action's redirect through the
// router: the soft RSC navigation to /login becomes a HARD browser navigation,
// which tears down every in-flight prefetch. Five SIGNOUT-01 cases reddened on
// "ordinary logout logs no console error" while their logouts were otherwise
// perfect — 1 POST, 0 sessions, 0 refresh tokens, cookie cleared, /login
// reached, every single run. Both wrapper shapes were tried: an `async`
// function that awaits, and one that returns the ORIGINAL promise untouched.
// Identical result, locally and in CI, so the cause is the client function
// itself and not how the promise is handled inside it.
//
// `<form action={signOut}>` therefore stays exactly as SIGNOUT-01 left it.
//
// DOCUMENT-SCOPED, deliberately. This is per-tab state, which is the correct
// scope: a second document is a different browsing context and is handled by
// the separate rule that holds every menu destination while a logout is in
// flight, so no link can open one.

let inFlight = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Publish a transition seen by a reporter inside a persistent sign-out form.
 *
 * COUNTED rather than boolean: both shells host a form and a reporter, so two
 * can publish, and a second one settling must not lower a hold the first is
 * still holding.
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

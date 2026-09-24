"use client";

import { useSyncExternalStore } from "react";

// SIGNOUT-02c · ONE logout-in-flight authority, shared by both responsive shells.
//
// THE DEFECT THIS CLOSES. `app/(app)/layout.tsx` renders BOTH menus on every
// page and hides one with CSS — `hidden … lg:flex` for the desktop account
// menu, `… lg:hidden` for the phone sheet. They are siblings that are always
// mounted, so when each owned its own `signingOut` useState the flag was
// per-shell rather than per-practitioner:
//
//   desktop Sign out pressed -> AccountMenu signingOut = true
//   viewport crosses lg      -> AccountMenu hidden, MobileMenu revealed
//   MobileMenu.signingOut    -> still false
//   -> a fresh ENABLED Sign out, while the first request is still in flight
//
// and the same in the other direction. Every other guard in SIGNOUT-02 was
// intact and irrelevant: they all read a flag that the other shell did not
// have.
//
// WHY A MODULE STORE AND NOT A CONTEXT PROVIDER. Lifting to the nearest
// persistent shared owner is the right instinct, and that owner is
// `app/(app)/layout.tsx` — a SERVER component. Holding this state there means
// introducing a client provider around the header and threading it through,
// which is more moving parts in the shell than the fact deserves: it is one
// boolean, for one document, with no props and no tree position. A module-level
// store is already the nearest shared owner both shells can see, and
// `useSyncExternalStore` is the API React provides for exactly this. Nothing
// about navigation or layout changes.
//
// DOCUMENT-SCOPED, deliberately. This is per-tab state, which is the correct
// scope: a second document is a different browsing context and is handled by
// the separate rule that holds every menu destination while a logout is in
// flight, so no link can open one.

let inFlight = false;
const listeners = new Set<() => void>();

/**
 * Report whether a logout is in flight. Called by the submit leaf as
 * `useFormStatus` transitions, from whichever shell is showing.
 */
export function setSignOutInFlight(next: boolean): void {
  if (inFlight === next) return;
  inFlight = next;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): boolean {
  return inFlight;
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

/**
 * TEST SEAM ONLY. Resets the module flag between cases in the unit lane, where
 * the store would otherwise leak across tests in one worker. Never called by
 * the product.
 */
export function __resetSignOutInFlightForTests(): void {
  inFlight = false;
  listeners.clear();
}

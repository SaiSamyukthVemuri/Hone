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
//
// ---------------------------------------------------------------------------
// WHY THE CLAIM IS TRACKED AND NOT JUST A BOOLEAN
//
// Module scope outlives the component tree, and that is the whole point — but
// it cut the other way too. Browser history can leave the `(app)` route group
// (back to `/admin`, say) while a logout is still in flight. That unmounts the
// submit leaf, which is the ONLY thing that can report `pending === false`.
// Component state died with the tree and took the problem with it; a module
// value survives in the client module cache, so navigating back rebuilt both
// shells with the flag still true — and the leaf deliberately suppresses its
// initial `false`, so nothing ever cleared it. Sign out and every destination
// stayed disabled for a request that had long since finished.
//
// So the flag is not "is a logout in flight" alone. It is "is a logout in
// flight AND is there still an owner that can tell us when it ends":
//
//   claim()  a leaf saw pending go true and is watching it
//   release() that same leaf saw it go false — the normal, boring path
//   orphan() the claiming leaf unmounted while still pending. The hold STAYS
//            (another shell must not offer a second logout just because a
//            panel closed), but the claim is now unowned
//   adopt()  a new leaf has mounted and found an unowned claim. Nothing in
//            this document can ever report that action's completion, so
//            continuing to hold would be permanent. Release it.
//
// `adopt` is the judgement call, and it is deliberate: a hold nobody can ever
// lift is worse than the duplicate it prevents, and the practitioner had to
// navigate out of the app and back for it to fire at all.

let inFlight = false;
/** True when the leaf that claimed the current hold has unmounted. */
let orphaned = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** A leaf saw its form go pending and is now watching it. */
export function claimSignOut(): void {
  if (inFlight && !orphaned) return;
  inFlight = true;
  orphaned = false;
  emit();
}

/** The claiming leaf saw the action settle. */
export function releaseSignOut(): void {
  if (!inFlight && !orphaned) return;
  inFlight = false;
  orphaned = false;
  emit();
}

/**
 * The claiming leaf unmounted while the action was still pending. The hold
 * stays — the other shell must not open up just because a panel went away —
 * but nothing is watching the action any more.
 */
export function orphanSignOut(): void {
  if (!inFlight || orphaned) return;
  orphaned = true;
  emit();
}

/**
 * A leaf mounted and found an unowned hold. Its own form is not the one that
 * started that action and can never report its completion, so the hold would
 * otherwise last until a full reload.
 */
export function adoptSignOut(): void {
  if (!inFlight || !orphaned) return;
  inFlight = false;
  orphaned = false;
  emit();
}

/**
 * What the shells hand the leaf: the leaf reports a boolean, and this maps it
 * onto the claim lifecycle so no call site has to know about orphaning.
 */
export function setSignOutInFlight(next: boolean): void {
  if (next) claimSignOut();
  else releaseSignOut();
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

/** True while a hold is standing with no leaf watching it. Tests read this. */
export function isSignOutClaimOrphaned(): boolean {
  return orphaned;
}

/**
 * TEST SEAM ONLY. Resets the module flags between cases in the unit lane, where
 * the store would otherwise leak across tests in one worker. Never called by
 * the product.
 */
export function __resetSignOutInFlightForTests(): void {
  inFlight = false;
  orphaned = false;
  listeners.clear();
}

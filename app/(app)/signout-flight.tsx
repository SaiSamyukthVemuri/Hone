"use client";

import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

// SIGNOUT-02c · ONE logout-in-flight hold, shared by both responsive shells
// and living exactly as long as they do.
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
// WHY THE HOLD IS PER-MOUNT AND NOT MODULE STATE. Keeping the counter at
// module scope left a hold that could OUTLIVE the only component able to
// release it. `useFormStatus` reports for the form its caller runs inside, so
// the observer is necessarily a component in the shell; if the whole `(app)`
// group unmounts while a logout is in flight, that observer goes with it and
// the settlement it was waiting for can never be reported. A module-scoped
// counter survives that, so RETURNING into the group in the same document
// rendered a fresh shell reading a hold nothing could ever clear — every menu
// permanently disabled.
//
// The authority therefore lives in a store created per PROVIDER MOUNT, which
// puts its lifetime exactly on the observer's: a shell that can still report a
// settlement always owns the hold it is reporting on, and a shell that cannot
// never inherits one. Nothing here infers settlement from a component's
// lifetime — a stranded store is not "settled", it is GONE along with the
// surface whose controls it was holding, and the next request on a destroyed
// session redirects to /login regardless.
//
// STILL ONE ANSWER FOR BOTH SHELLS. The provider wraps the header, above both
// menus, so a press in either one holds the other — the original defect — and
// both are released together.
//
// DOCUMENT-SCOPED, deliberately. Per-tab is the correct scope: a second
// document is a different browsing context, handled by the separate rule that
// holds every menu destination while a logout is in flight.

export type SignOutFlight = {
  /** Publish a transition seen by a reporter inside a sign-out form. */
  set(next: boolean): void;
  subscribe(onChange: () => void): () => void;
  get(): boolean;
};

/**
 * One independent hold.
 *
 * COUNTED and floored: both shells host a form and a reporter, so two can
 * publish, and neither a second one settling nor a stray release may lower a
 * hold the other still holds.
 *
 * Exported for the unit lane, which needs to drive a hold — and to prove that
 * two of these never share state — without a DOM.
 */
export function createSignOutFlight(): SignOutFlight {
  let inFlight = 0;
  const listeners = new Set<() => void>();

  return {
    set(next: boolean): void {
      inFlight += next ? 1 : -1;
      if (inFlight < 0) inFlight = 0;
      for (const listener of listeners) listener();
    },
    subscribe(onChange: () => void): () => void {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    get(): boolean {
      return inFlight > 0;
    },
  };
}

const SignOutFlightContext = createContext<SignOutFlight | null>(null);

/**
 * Owns the hold for one mounted app shell. Wraps the header in
 * `app/(app)/layout.tsx`, above both responsive menus.
 */
export function SignOutFlightProvider({ children }: { children: ReactNode }) {
  // ONE store for the life of this mount, and a new one for the next.
  const store = useRef<SignOutFlight | null>(null);
  store.current ??= createSignOutFlight();

  return (
    <SignOutFlightContext.Provider value={store.current}>
      {children}
    </SignOutFlightContext.Provider>
  );
}

function useSignOutFlight(): SignOutFlight {
  const store = useContext(SignOutFlightContext);
  if (!store) {
    // Loud rather than silent: without the provider the two shells would hold
    // separate flags, which is the breakpoint defect this file exists to close.
    throw new Error(
      "SignOutFlightProvider is missing above this shell — the sign-out hold would not be shared between the desktop and phone menus.",
    );
  }
  return store;
}

// The server never has a logout in flight, and this must be a STABLE value
// rather than a fresh one per call, or React re-renders forever.
function getServerSnapshot(): boolean {
  return false;
}

/** Subscribe to this shell's hold. Both menus call this and see one answer. */
export function useSignOutInFlight(): boolean {
  const store = useSignOutFlight();
  return useSyncExternalStore(store.subscribe, store.get, getServerSnapshot);
}

/** Publish into this shell's hold. */
export function useSetSignOutInFlight(): (next: boolean) => void {
  return useSignOutFlight().set;
}

"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import { useSetSignOutInFlight } from "./signout-flight";

/**
 * SIGNOUT-02c · watches one sign-out form and RELEASES the shared hold when it
 * settles. It does not acquire.
 *
 * WHY IT DOES NOT ACQUIRE, which was a real gap rather than a tidiness
 * preference. The visible Sign out control lives in the panel, OUTSIDE this
 * hidden form, so its own `useFormStatus()` is always false — the only thing
 * that disables it is `busy` arriving from the shared store. When acquisition
 * happened in this effect, the control stayed enabled for the whole gap
 * between the press and the passive effect running, and a fast double-press
 * queued a second logout through it. The form's `onSubmit` now takes the hold
 * synchronously, during the submit event, before any effect gets a turn.
 *
 * WHERE THIS LIVES IS STILL THE POINT. `useFormStatus` reports only for the
 * form it runs inside, so the observer has to be IN the form — and that form
 * sits on the shell's persistent root, outside the `{open && …}` panel.
 * Closing the panel, crossing the `lg` breakpoint, or holding a link cannot
 * unmount it.
 *
 * IT OBSERVES; IT DOES NOT SUBMIT. The form's action is the server action
 * itself, so the native submission path is untouched and the logout still
 * works before this component — or any component — has hydrated.
 *
 * NO UNMOUNT CLEANUP, deliberately. A component going away is not evidence
 * that the request ended; releasing there previously let a second logout be
 * submitted while the first was still running. Nor does the hold need one: it
 * belongs to the shell this reporter lives in and is gone when that shell is,
 * so it can never outlast the observer able to release it. See
 * ./signout-flight.
 */
export function SignOutFlightReporter() {
  const { pending } = useFormStatus();
  const setSignOutInFlight = useSetSignOutInFlight();
  // Only a reporter that actually SAW the submission may release it.
  const sawPending = useRef(false);

  useEffect(() => {
    if (pending) {
      sawPending.current = true;
      return;
    }
    if (!sawPending.current) return;
    sawPending.current = false;
    setSignOutInFlight(false);
  }, [pending, setSignOutInFlight]);

  return null;
}

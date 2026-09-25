"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import { setSignOutInFlight } from "./signout-flight";

/**
 * SIGNOUT-02c · watches one sign-out form and publishes its status.
 *
 * WHERE IT LIVES IS THE POINT. `useFormStatus` reports only for the form it
 * runs inside, so the observer has to be IN the form — and that form now sits
 * on the shell's persistent root, outside the `{open && …}` panel. Closing the
 * panel, crossing the `lg` breakpoint, or holding a link cannot unmount this.
 * Earlier revisions put the observer in the panel's submit control, which is
 * exactly why the flag kept being lost.
 *
 * IT OBSERVES; IT DOES NOT SUBMIT. The form's action is the server action
 * itself, so the native submission path is untouched and the logout still
 * works before this component — or any component — has hydrated. Tracking is
 * layered on top of that path, never in place of it.
 *
 * It renders nothing.
 *
 * ONLY TRANSITIONS ARE PUBLISHED, and there is deliberately NO unmount
 * cleanup. A component going away is not evidence that the request ended; a
 * previous revision released the shared hold from cleanup and thereby let a
 * second logout be submitted while the first was still running. The residual
 * that leaves is recorded in ./signout-flight.
 */
export function SignOutFlightReporter() {
  const { pending } = useFormStatus();
  const published = useRef(false);

  useEffect(() => {
    if (pending === published.current) return;
    published.current = pending;
    setSignOutInFlight(pending);
  }, [pending]);

  return null;
}

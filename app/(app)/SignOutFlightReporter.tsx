"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import { setSignOutInFlight } from "./signout-flight";

/**
 * SIGNOUT-02c · watches one sign-out form and publishes its status.
 *
 * WHERE IT LIVES IS THE WHOLE POINT. `useFormStatus` reports only for the form
 * it runs inside, so the observer has to be in the form — and the form is now
 * in the PERSISTENT part of the shell, outside the `{open && …}` panel. This
 * component therefore cannot be unmounted by dismissing a panel, crossing the
 * `lg` breakpoint, or anything else the practitioner can do to the menu while
 * the request is running. Earlier revisions put the observer in the panel's
 * submit control, which is exactly why the flag kept being lost or stranded.
 *
 * It renders nothing. It is an observer, not a control.
 *
 * ONLY TRANSITIONS ARE PUBLISHED. The store counts, so a spurious `false` on
 * mount would decrement a hold this form never placed.
 */
export function SignOutFlightReporter() {
  const { pending } = useFormStatus();
  const published = useRef(false);

  useEffect(() => {
    if (pending === published.current) return;
    published.current = pending;
    setSignOutInFlight(pending);
  }, [pending]);

  // If this form is ever torn down mid-flight — the whole shell going away,
  // which is the only way left — it takes its own hold with it rather than
  // leaving a count nobody will ever decrement.
  useEffect(() => {
    return () => {
      if (published.current) {
        published.current = false;
        setSignOutInFlight(false);
      }
    };
  }, []);

  return null;
}

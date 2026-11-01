"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useUnsavedChangesGuard } from "./unsaved-changes";

// Unsaved-changes guard for a server-rendered <form>. Drop <FormDirtyGuard
// name="..." /> inside the form: it snapshots the field values on mount, reports
// dirty while they differ, and re-baselines on submit so that a saved form reads
// clean and a LATER edit is measured against what was saved, not against what
// the page first loaded with. A save the server refuses comes back with an
// `error` search param (the booking and service actions redirect that way); the
// baseline is then rolled back so the unsaved edits are guarded again. It never
// changes a field or an action.
//
// WHEN A SAVE HAS "ARRIVED" is not visible in the URL alone: a second refused
// save redirects to the very same `?error=` URL as the first. The server page
// therefore passes `token`, a value that changes on every server render, and the
// guard settles a pending submit each time the token changes.

/**
 * What the baseline becomes when the server response for a submit arrives:
 * the pre-submit baseline after a refusal, otherwise null (keep the baseline
 * taken at submit, so edits typed while the save was in flight stay dirty).
 */
export function baselineAfterArrival(opts: {
  awaiting: boolean;
  refused: boolean;
  before: string | null;
}): string | null {
  if (!opts.awaiting) return null;
  return opts.refused ? opts.before : null;
}

function snapshot(form: HTMLFormElement): string {
  const entries: string[] = [];
  new FormData(form).forEach((value, key) => {
    if (typeof value === "string") entries.push(`${key}=${value}`);
  });
  return entries.join("\u0000");
}

export function FormDirtyGuard({ name, token }: { name: string; token: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const baseline = useRef<string | null>(null);
  const previous = useRef<string | null>(null);
  const awaiting = useRef(false);
  const [dirty, setDirty] = useState(false);
  const search = useSearchParams();
  const hasError = search?.has("error") ?? false;
  useUnsavedChangesGuard(name, dirty);

  useEffect(() => {
    const form = marker.current?.closest("form");
    if (!form) return;
    baseline.current = snapshot(form);
    const check = () => setDirty(snapshot(form) !== baseline.current);
    const onSubmit = () => {
      previous.current = baseline.current;
      baseline.current = snapshot(form);
      awaiting.current = true;
      setDirty(false);
    };
    // A save that succeeds without a redirect (the new-service form) makes React
    // reset the form's fields. The reset event fires before the values change, so
    // the resting snapshot is taken after it: the baseline is the empty form, not
    // the submitted values, and the saved form reads clean.
    const onReset = () => {
      setTimeout(() => {
        baseline.current = snapshot(form);
        previous.current = null;
        awaiting.current = false;
        setDirty(false);
      }, 0);
    };
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    form.addEventListener("submit", onSubmit);
    form.addEventListener("reset", onReset);
    return () => {
      form.removeEventListener("input", check);
      form.removeEventListener("change", check);
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("reset", onReset);
    };
  }, []);

  // The server answered the last submit (the token changed). A refused save (an
  // `error` param) leaves the edits unsaved, so the baseline goes back to what it
  // was before the submit - every time, including a second refusal at the same URL.
  useEffect(() => {
    if (!awaiting.current) return;
    const form = marker.current?.closest("form");
    if (!form) return;
    const next = baselineAfterArrival({
      awaiting: true,
      refused: hasError,
      before: previous.current,
    });
    awaiting.current = false;
    previous.current = null;
    if (next !== null) baseline.current = next;
    setDirty(snapshot(form) !== baseline.current);
  }, [token, hasError]);

  return <span ref={marker} hidden />;
}

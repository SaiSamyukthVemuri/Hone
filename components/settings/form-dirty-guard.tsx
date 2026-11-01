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

function snapshot(form: HTMLFormElement): string {
  const entries: string[] = [];
  new FormData(form).forEach((value, key) => {
    if (typeof value === "string") entries.push(`${key}=${value}`);
  });
  return entries.join("\u0000");
}

export function FormDirtyGuard({ name }: { name: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const baseline = useRef<string | null>(null);
  const previous = useRef<string | null>(null);
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
      setDirty(false);
    };
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    form.addEventListener("submit", onSubmit);
    return () => {
      form.removeEventListener("input", check);
      form.removeEventListener("change", check);
      form.removeEventListener("submit", onSubmit);
    };
  }, []);

  // A refused save: the edits are still unsaved, so measure against the baseline
  // from before the submit.
  useEffect(() => {
    if (!hasError || previous.current === null) return;
    const form = marker.current?.closest("form");
    if (!form) return;
    baseline.current = previous.current;
    previous.current = null;
    setDirty(snapshot(form) !== baseline.current);
  }, [hasError]);

  return <span ref={marker} hidden />;
}

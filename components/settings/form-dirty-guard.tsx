"use client";

import { useEffect, useRef, useState } from "react";
import { useUnsavedChangesGuard } from "./unsaved-changes";

// Unsaved-changes guard for a server-rendered <form>. Drop <FormDirtyGuard
// name="..." /> inside the form: it snapshots the field values on mount, reports
// dirty while they differ, and goes clean on submit (the save redirects, so the
// page remounts with the saved values). It never changes a field or an action.

function snapshot(form: HTMLFormElement): string {
  const entries: string[] = [];
  new FormData(form).forEach((value, key) => {
    if (typeof value === "string") entries.push(`${key}=${value}`);
  });
  return entries.join("\u0000");
}

export function FormDirtyGuard({ name }: { name: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesGuard(name, dirty);

  useEffect(() => {
    const form = marker.current?.closest("form");
    if (!form) return;
    const initial = snapshot(form);
    const check = () => setDirty(snapshot(form) !== initial);
    const clean = () => setDirty(false);
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    form.addEventListener("submit", clean);
    return () => {
      form.removeEventListener("input", check);
      form.removeEventListener("change", check);
      form.removeEventListener("submit", clean);
    };
  }, []);

  return <span ref={marker} hidden />;
}

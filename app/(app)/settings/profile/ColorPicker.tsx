"use client";

import { useState, useTransition } from "react";
import { PRACTITIONER_COLORS } from "@/lib/practitioner-colors";
import { updatePractitionerColorAction } from "./actions";

type Props = {
  initialColor: string;
};

export function ColorPicker({ initialColor }: Props) {
  const [selected, setSelected] = useState(initialColor);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState(false);

  function pick(token: string) {
    if (token === selected || pending) return;
    setError(null);
    const previous = selected;
    setSelected(token); // optimistic
    const fd = new FormData();
    fd.set("color", token);
    startTransition(async () => {
      try {
        await updatePractitionerColorAction(fd);
        setSavedHint(true);
        window.setTimeout(() => setSavedHint(false), 1500);
      } catch (err) {
        setSelected(previous);
        setError(err instanceof Error ? err.message : "Failed to save.");
      }
    });
  }

  return (
    <div id="calendar-color" className="flex scroll-mt-24 flex-col gap-2">
      <span className="text-sm font-medium">Calendar color</span>
      <span className="text-xs text-neutral-500">
        Your appointments will appear in this color on the calendar.
      </span>
      <div className="mt-2 flex flex-wrap gap-3">
        {PRACTITIONER_COLORS.map((c) => {
          const isSelected = c.token === selected;
          return (
            <button
              key={c.token}
              type="button"
              onClick={() => pick(c.token)}
              disabled={pending}
              aria-label={`${c.label} appointment color${isSelected ? ", selected" : ""}`}
              aria-pressed={isSelected}
              className={`h-7 w-7 rounded-full ${c.bg} transition disabled:opacity-50 ${
                isSelected
                  ? "ring-2 ring-offset-2 ring-neutral-900 ring-offset-white dark:ring-white dark:ring-offset-neutral-950"
                  : "hover:scale-110"
              }`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs">
        {savedHint && (
          <span className="text-green-600 dark:text-green-400">Saved</span>
        )}
        {error && (
          <span className="text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
    </div>
  );
}

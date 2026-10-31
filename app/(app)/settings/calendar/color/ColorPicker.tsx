"use client";

import { useState, useTransition } from "react";
import { PRACTITIONER_COLORS, resolvePractitionerColor } from "@/lib/practitioner-colors";
import { updatePractitionerColorAction } from "../../profile/actions";
import { applySuggestedColourAction } from "./actions";

type Props = {
  initialColor: string;
  // Palette order with how many OTHER practitioners hold each colour (information only).
  options: ReadonlyArray<{ token: string; label: string; takenBy: number }>;
  // A distinct colour for a practitioner still on the default; null once chosen or exhausted.
  suggestion: string | null;
};

export function ColorPicker({ initialColor, options, suggestion }: Props) {
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

  function applySuggestion() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const r = await applySuggestedColourAction();
      if (r.ok) {
        setSelected(r.color); // the colour the server actually saved, never the one the page suggested
        setSavedHint(true);
        window.setTimeout(() => setSavedHint(false), 1500);
      } else {
        setError(r.error);
      }
    });
  }

  const takenBy = options.find((o) => o.token === selected)?.takenBy ?? 0;
  const suggestedLabel = suggestion ? resolvePractitionerColor(suggestion).label : null;

  return (
    <div id="calendar-color" className="flex scroll-mt-24 flex-col gap-2">
      <span className="text-sm font-medium">Calendar color</span>
      <span className="text-xs text-neutral-500">
        Your appointments will appear in this color on the calendar.
      </span>
      {suggestion && selected === "neutral" && (
        <div data-testid="colour-suggestion" className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Suggested for you: <strong>{suggestedLabel}</strong> (no one else uses it).
          </span>
          <button
            type="button"
            onClick={applySuggestion}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
          >
            Use {suggestedLabel}
          </button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-3">
        {PRACTITIONER_COLORS.map((c) => {
          const isSelected = c.token === selected;
          const taken = options.find((o) => o.token === c.token)?.takenBy ?? 0;
          return (
            <button
              key={c.token}
              type="button"
              onClick={() => pick(c.token)}
              disabled={pending}
              aria-label={`${c.label} appointment color${isSelected ? ", selected" : ""}${taken > 0 ? ", also used by a colleague" : ""}`}
              data-taken-by={taken}
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
      {takenBy > 0 && (
        <span data-testid="colour-shared-note" className="text-xs text-amber-700 dark:text-amber-400">
          {takenBy === 1 ? "A colleague also uses this colour." : `${takenBy} colleagues also use this colour.`} You can keep it; the name is always shown beside the colour.
        </span>
      )}
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

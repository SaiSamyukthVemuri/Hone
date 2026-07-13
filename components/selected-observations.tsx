"use client";

// "Selected observations" confidence summary for the charting forms.
//
// Chloe's feedback: tapping an observation chip selects it, but nothing
// visibly told her WHAT would be saved, so she wasn't confident the
// selection "took". This renders the current structured selection as a
// clear, adjacent read-out — a plain sentence of the selected chip labels,
// or an explicit empty state — so the practitioner always sees exactly what
// will be stored to observation_chips (separate from the free-text note).
//
// Pure display. It reads the same `chips` state the toggle buttons drive; it
// never mutates state and never writes anything back into the free-text box.

export function SelectedObservations({ chips }: { chips: readonly string[] }) {
  const has = chips.length > 0;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Selected observations
      </span>
      <p
        data-testid="selected-observations"
        aria-live="polite"
        className={
          has
            ? "text-sm text-neutral-800 dark:text-neutral-200"
            : "text-sm italic text-neutral-400"
        }
      >
        {has ? chips.join(" · ") : "No observations selected"}
      </p>
    </div>
  );
}

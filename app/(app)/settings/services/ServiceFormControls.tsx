"use client";

// Small client components co-located with the Services settings page.
// They exist only to provide UI affordances (preset duration buttons +
// in-flight save feedback) on top of the existing server forms. They
// do NOT change the server actions, the FormData shape, or the
// validation rules — every input still submits as
// `default_duration_minutes`, `name`, etc., and is parsed by the
// unchanged actions.ts handlers.

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";

const DURATION_PRESETS_MINUTES: ReadonlyArray<number> = [15, 30, 45, 60, 90];

// Number input for duration + a row of preset shortcut buttons. The
// preset buttons set the input's value (and dispatch an input event so
// React's controlled-component watchers see the change), so the form
// still posts the canonical `default_duration_minutes` field that the
// existing server action expects.
export function DurationField({
  name,
  defaultValue,
  required,
}: {
  name: string;
  defaultValue?: number;
  required?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState<string>(
    defaultValue != null ? String(defaultValue) : "",
  );

  function applyPreset(minutes: number) {
    setValue(String(minutes));
    // Reflect on the underlying input so the form submission picks up
    // the new value. defaultValue won't update once mounted, so we
    // drive value through React state.
    const el = ref.current;
    if (el) {
      el.value = String(minutes);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={ref}
        name={name}
        type="number"
        min={5}
        max={480}
        step={5}
        required={required}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Minutes"
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
      />
      <div className="flex flex-wrap gap-1">
        {DURATION_PRESETS_MINUTES.map((m) => {
          const selected = value === String(m);
          return (
            <button
              key={m}
              type="button"
              onClick={() => applyPreset(m)}
              aria-pressed={selected}
              className={`rounded-md border px-2 py-0.5 text-[11px] tabular-nums transition ${
                selected
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                  : "border-neutral-300 text-neutral-600 hover:border-neutral-500 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:text-neutral-100"
              }`}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Submit button that shows in-flight feedback via useFormStatus().
// Renders within a parent <form action={...}> — same form-element
// scope as the existing button it replaces. No server-action change.
// While pending the button is disabled and reads "Saving…"; otherwise
// it shows the supplied idleLabel. The page re-render that Next.js
// triggers on revalidatePath() is the implicit "saved" confirmation.
export function ServiceSubmitButton({
  idleLabel,
  pendingLabel,
  variant = "secondary",
}: {
  idleLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();
  const base =
    variant === "primary"
      ? "rounded-md bg-neutral-900 px-3 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      : "rounded-md border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900";
  return (
    <button type="submit" disabled={pending} className={base}>
      {pending ? pendingLabel ?? "Saving…" : idleLabel}
    </button>
  );
}

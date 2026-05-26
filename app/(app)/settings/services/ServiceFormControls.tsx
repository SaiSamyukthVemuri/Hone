"use client";

// Small client components co-located with the Services settings page.
// They exist only to provide UI affordances (preset duration pills +
// in-flight save feedback) on top of the existing server forms. They
// do NOT change the server actions, the FormData shape, or the
// validation rules — every input still submits as
// `default_duration_minutes`, `name`, etc., and is parsed by the
// unchanged actions.ts handlers.

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";

const DURATION_PRESETS_MINUTES: ReadonlyArray<number> = [15, 30, 45, 60, 90];

// Duration field. The presets sit as a tight pill row directly above
// the number input. Clicking a preset sets the input value (and
// dispatches an input event so any controlled-input watchers see the
// change). Custom durations still work — the input is a normal
// number field with min=5, max=480, step=5. FormData submits as
// `default_duration_minutes` exactly as the unchanged action expects.
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
    const el = ref.current;
    if (el) {
      el.value = String(minutes);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-nowrap gap-1">
        {DURATION_PRESETS_MINUTES.map((m) => {
          const selected = value === String(m);
          return (
            <button
              key={m}
              type="button"
              onClick={() => applyPreset(m)}
              aria-pressed={selected}
              className={`flex-1 rounded-md border px-2 py-1.5 text-[12px] tabular-nums transition ${
                selected
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                  : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:border-neutral-500 dark:hover:text-neutral-100"
              }`}
            >
              {m}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
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
          placeholder="60"
          className="w-20 rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
        <span className="text-xs text-neutral-500">minutes</span>
      </div>
    </div>
  );
}

// Submit button that shows in-flight feedback via useFormStatus().
// Renders inside the parent <form action={...}> — same scope as the
// existing button it replaces. While pending the button is disabled
// and reads pendingLabel; otherwise it shows idleLabel. The page
// re-render that Next.js triggers on revalidatePath() is the implicit
// "saved" confirmation. No server-action change.
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
      ? "rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      : "rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200";
  return (
    <button type="submit" disabled={pending} className={base}>
      {pending ? pendingLabel ?? "Saving…" : idleLabel}
    </button>
  );
}

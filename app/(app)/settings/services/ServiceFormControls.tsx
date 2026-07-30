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
import { SERVICE_COLOR_KEYS, isServiceColorKey } from "@/lib/calendar/service-colors";

const DURATION_PRESETS_MINUTES: ReadonlyArray<number> = [15, 30, 45, 60, 90];

// Swatch dot per allowed color key (preview only; the real card bundle lives in
// lib/calendar/service-colors.ts). No rose/red/pink — reserved for allergy and
// clinical-caution signals. Tones mirror the palette's light/deep alternation so
// the swatch previews the separation the calendar card will actually show.
const COLOR_SWATCH: Record<string, string> = {
  amber: "bg-amber-400",
  emerald: "bg-emerald-600",
  teal: "bg-teal-400",
  sky: "bg-sky-400",
  indigo: "bg-indigo-600",
  violet: "bg-violet-400",
  orange: "bg-orange-600",
  lime: "bg-lime-500",
  fuchsia: "bg-fuchsia-600",
  slate: "bg-slate-500",
};

// "Calendar color" selector: six named, accessible swatches that submit the
// chosen KEY via a hidden `calendar_color` input. Pre-selects the stored value.
// Wraps so it never overflows at iPhone width. The server action re-validates the
// value against the same allowlist; the DB CHECK is the final backstop.
export function CalendarColorField({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue?: string | null;
}) {
  const keys = SERVICE_COLOR_KEYS as readonly string[];
  const initial = defaultValue && keys.includes(defaultValue) ? defaultValue : "sky";
  const [value, setValue] = useState<string>(initial);
  return (
    <div className="flex flex-col gap-1.5">
      <input type="hidden" name={name} value={value} />
      <div className="flex flex-wrap gap-2">
        {SERVICE_COLOR_KEYS.map((key) => {
          const selected = value === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setValue(key)}
              aria-pressed={selected}
              aria-label={`Calendar color: ${key}`}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] capitalize transition ${
                selected
                  ? "border-neutral-900 bg-neutral-100 dark:border-neutral-100 dark:bg-neutral-800"
                  : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
              }`}
            >
              <span
                aria-hidden
                className={`inline-block h-3 w-3 rounded-full ${COLOR_SWATCH[key]}`}
              />
              {key}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Left accent bar + swatch dot per colour key, for the collapsed settings row.
// Separate from the calendar card bundle (which needs a background fill); this
// only needs a border + dot, and Tailwind class names must be literal so they
// survive the content scan.
const ROW_ACCENT: Record<string, { border: string; dot: string }> = {
  amber: { border: "border-l-amber-500", dot: "bg-amber-400" },
  emerald: { border: "border-l-emerald-600", dot: "bg-emerald-600" },
  teal: { border: "border-l-teal-500", dot: "bg-teal-400" },
  sky: { border: "border-l-sky-500", dot: "bg-sky-400" },
  indigo: { border: "border-l-indigo-600", dot: "bg-indigo-600" },
  violet: { border: "border-l-violet-500", dot: "bg-violet-400" },
  orange: { border: "border-l-orange-600", dot: "bg-orange-600" },
  lime: { border: "border-l-lime-600", dot: "bg-lime-500" },
  fuchsia: { border: "border-l-fuchsia-600", dot: "bg-fuchsia-600" },
  slate: { border: "border-l-slate-600", dot: "bg-slate-500" },
};
const ROW_ACCENT_NEUTRAL = {
  border: "border-l-neutral-300 dark:border-l-neutral-700",
  dot: "bg-neutral-300 dark:bg-neutral-600",
};

// Status pill shown in the collapsed service row. Copy is booking-centric
// ("Visible in booking" / "Hidden from booking") so the effect of the
// Hide/Show toggle is unambiguous. Emerald = visible (positive), neutral =
// hidden. Presentational only.
function StatusPill({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-medium text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
        />
        Visible in booking
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-200 px-2.5 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-500"
      />
      Hidden from booking
    </span>
  );
}

// Collapsible service row. Collapsed by default: a compact summary
// (name · duration · price · status pill) with the Hide/Show toggle and an
// Edit control on the right. Expanding reveals the edit form (passed as
// children). Each row owns its own open state, so multiple rows can be open
// at once and toggling one never affects another. The `toggle` slot is the
// standalone visibility form (its own <form>, never nested in the edit form
// — preserves the PR #35 fix). No server-action or FormData changes.
export function ServiceAccordionItem({
  name,
  durationLabel,
  priceLabel,
  active,
  colorKey,
  toggle,
  children,
}: {
  name: string;
  durationLabel: string;
  priceLabel: string;
  active: boolean;
  // The service's persisted calendar colour, rendered as a left accent bar +
  // swatch so the row is identifiable at a glance and matches the calendar
  // card. Null when the column is not available yet (pre-0153 deploy window).
  colorKey?: string | null;
  toggle: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const accent = isServiceColorKey(colorKey) ? ROW_ACCENT[colorKey] : ROW_ACCENT_NEUTRAL;
  return (
    <article
      className={`overflow-hidden rounded-lg border border-l-4 border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950 ${accent.border} ${
        active ? "" : "opacity-90"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left"
        >
          <span aria-hidden className="text-neutral-400">
            {open ? "▾" : "▸"}
          </span>
          <span
            aria-hidden
            className={`inline-block h-3 w-3 shrink-0 rounded-full ${accent.dot}`}
          />
          <span className="truncate font-medium text-neutral-900 dark:text-neutral-100">
            {name}
          </span>
          {/* Colour is NEVER the only identifier: the calendar colour is also
              spelled out in words next to the swatch. */}
          {isServiceColorKey(colorKey) && (
            <span className="text-[11px] capitalize text-neutral-500">{colorKey}</span>
          )}
          <span className="text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
            {durationLabel}
          </span>
          <span className="text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
            {priceLabel}
          </span>
          <StatusPill active={active} />
        </button>
        <div className="flex flex-shrink-0 items-center gap-2">
          {toggle}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            {open ? "Close" : "Edit"}
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-neutral-200 px-4 py-4 dark:border-neutral-800">
          {children}
        </div>
      )}
    </article>
  );
}

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

// Hide-from-booking / Show-in-booking toggle submit. Lives in its OWN
// <form action={toggleServiceActiveAction}> in the card header — NOT
// nested inside the edit form (a nested <form> is invalid HTML; the
// browser drops the inner one, which is why this toggle previously
// "did nothing": the click submitted the outer edit form instead of the
// toggle action). useFormStatus gives clear in-flight feedback, and the
// revalidatePath() in the action re-renders the card with the flipped
// state. No server-action change.
export function ToggleActiveSubmitButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus();
  const idle = active ? "Hide from booking" : "Show in booking";
  const busy = active ? "Hiding…" : "Showing…";
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
    >
      {pending ? busy : idle}
    </button>
  );
}

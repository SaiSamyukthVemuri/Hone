"use client";

import { useState, useTransition } from "react";
import type { StudioRecurringBreakRule } from "@/lib/types/database";
import { formatClockLabel, type TimeFormat } from "@/lib/booking/tz";
import {
  createRecurringBreakRuleAction,
  deleteRecurringBreakRuleAction,
  toggleRecurringBreakRuleActiveAction,
  updateRecurringBreakRuleAction,
} from "./actions";
import {
  ScopeField,
  scopeRowLabel,
  type ScopeDirectory,
  type ScopeSelectable,
  type ViewScope,
} from "./ScopeField";

type Props = {
  rules: ReadonlyArray<StudioRecurringBreakRule>;
  // Migration 0109: 12h/24h preference for the DISPLAYED break times. The form
  // <input type="time"> fields stay 24h HH:MM machine values.
  timeFormat: TimeFormat;
  // Scope wiring (PR B 3E-6). Absent = Legacy studio: no scope selector, and
  // the parent has already filtered to studio-wide rules only.
  capacityOn?: boolean;
  viewScope?: ViewScope;
  selectable?: ReadonlyArray<ScopeSelectable>;
  directory?: ScopeDirectory;
};

// Migration 0037: the recurring-break label column accepts free text
// now (1..60 chars). These preset suggestions are a UX nicety —
// clicking a pill fills the text input — but the practitioner can type
// any label they want ("Dinner", "School pickup", "Yoga", …).
const LABEL_PRESETS: ReadonlyArray<string> = [
  "Lunch",
  "Dinner",
  "Admin",
  "Personal",
  "Break",
];
const LABEL_MAX_LENGTH = 60;

const WEEKDAY_LABELS = [
  { value: 0, short: "Sun" },
  { value: 1, short: "Mon" },
  { value: 2, short: "Tue" },
  { value: 3, short: "Wed" },
  { value: 4, short: "Thu" },
  { value: 5, short: "Fri" },
  { value: 6, short: "Sat" },
];

// Display helper: known legacy values keep their old display
// capitalization; everything else renders with the practitioner's
// supplied casing (with a tidy first-letter uppercase if it was typed
// all-lowercase). Mirrors displayRecurringBreakLabel in DayColumn.tsx.
const LEGACY_LABEL_DISPLAY: Record<string, string> = {
  lunch: "Lunch",
  break: "Break",
  admin: "Admin",
  other: "Other",
};
function formatLabel(v: string): string {
  const t = v.trim();
  if (t.length === 0) return "Break";
  const known = LEGACY_LABEL_DISPLAY[t.toLowerCase()];
  if (known) return known;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function formatDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.map((d) => WEEKDAY_LABELS[d]?.short ?? "").join(", ");
}

// Postgres TIME may come back as "HH:MM:SS"; the form input expects HH:MM and
// the shared formatClockLabel expects a bare "HH:MM" (it applies no timezone —
// break times are naive local wall-clock, not UTC instants).
function trimSeconds(time: string): string {
  return time.slice(0, 5);
}

const DEFAULT_LABEL = "Lunch";
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_START = "12:00";
const DEFAULT_END = "12:30";

export function RecurringBreaksSection({
  rules,
  timeFormat,
  capacityOn = false,
  viewScope = { kind: "studio" },
  selectable = [],
  directory = {},
}: Props) {
  // Default target for a NEW rule: the practitioner the view is anchored to, or
  // studio-wide under the Studio-default view.
  const defaultScope =
    viewScope.kind === "practitioner" ? viewScope.practitionerId : "";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState(DEFAULT_LABEL);
  const [days, setDays] = useState<number[]>(DEFAULT_DAYS);
  const [startLocal, setStartLocal] = useState(DEFAULT_START);
  const [endLocal, setEndLocal] = useState(DEFAULT_END);
  const [active, setActive] = useState(true);
  const [scope, setScope] = useState<string>(defaultScope);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function resetForm() {
    setEditingId(null);
    setLabel(DEFAULT_LABEL);
    setDays(DEFAULT_DAYS);
    setStartLocal(DEFAULT_START);
    setEndLocal(DEFAULT_END);
    setActive(true);
    setScope(defaultScope);
    setError(null);
  }

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort(),
    );
  }

  function onEdit(r: StudioRecurringBreakRule) {
    setEditingId(r.id);
    setLabel(r.label);
    setDays([...r.days_of_week]);
    setStartLocal(trimSeconds(r.start_local_time));
    setEndLocal(trimSeconds(r.end_local_time));
    setActive(r.active);
    setScope(r.practitioner_id ?? "");
    setError(null);
  }

  function onSubmit() {
    setError(null);
    const fd = new FormData();
    fd.set("label", label);
    fd.set("days_of_week", days.join(","));
    fd.set("start_local", startLocal);
    fd.set("end_local", endLocal);
    fd.set("active", active ? "true" : "false");
    // Only send an explicit scope when capacity is on. In Legacy the action
    // never sees the field and preserves studio-wide (see resolveSubmittedScope).
    if (capacityOn) fd.set("practitioner_id", scope);
    if (editingId) fd.set("id", editingId);

    startTransition(async () => {
      try {
        const result = editingId
          ? await updateRecurringBreakRuleAction(fd)
          : await createRecurringBreakRuleAction(fd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        resetForm();
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : editingId
              ? "Failed to update recurring break."
              : "Failed to add recurring break.",
        );
      }
    });
  }

  function onToggleActive(r: StudioRecurringBreakRule) {
    const fd = new FormData();
    fd.set("id", r.id);
    fd.set("active", r.active ? "false" : "true");
    startTransition(async () => {
      try {
        const result = await toggleRecurringBreakRuleActiveAction(fd);
        if (!result.ok) {
          setError(result.error);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to toggle rule.");
      }
    });
  }

  function onDelete(id: string) {
    const fd = new FormData();
    fd.set("id", id);
    startTransition(async () => {
      try {
        const result = await deleteRecurringBreakRuleAction(fd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (editingId === id) resetForm();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete rule.");
      }
    });
  }

  const submitLabel = editingId
    ? pending
      ? "Saving…"
      : "Save changes"
    : pending
      ? "Saving…"
      : "Add repeating break";

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 id="repeating-breaks" className="scroll-mt-24 text-xl font-medium">
          Repeating breaks
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Set up the regular times you&rsquo;re unavailable each week:
          lunch, dinner, admin, or personal time. Generated up to a year
          ahead and refreshed daily. Labels are private to your studio;
          clients only see the slot as unavailable.
        </p>
      </div>

      <div className="grid gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
        {editingId && (
          <div className="rounded bg-neutral-100 px-2 py-1 text-xs uppercase tracking-wider text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            Editing rule
          </div>
        )}
        {capacityOn && (
          <ScopeField
            value={scope}
            onChange={setScope}
            selectable={selectable}
            directory={directory}
            disabled={pending}
          />
        )}
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Label
            </span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={LABEL_MAX_LENGTH}
              placeholder="Lunch, Dinner, Admin, Personal…"
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {LABEL_PRESETS.map((preset) => {
              const selected = label.trim().toLowerCase() === preset.toLowerCase();
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setLabel(preset)}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                    selected
                      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-500 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:text-neutral-100"
                  }`}
                >
                  {preset}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Start
            </span>
            <input
              type="time"
              value={startLocal}
              step={300}
              onChange={(e) => setStartLocal(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              End
            </span>
            <input
              type="time"
              value={endLocal}
              step={300}
              onChange={(e) => setEndLocal(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Weekdays
          </span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Weekdays">
            {WEEKDAY_LABELS.map((d) => {
              const checked = days.includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => toggleDay(d.value)}
                  aria-pressed={checked}
                  // Selected uses a distinct emerald accent (not the
                  // neutral black/white pair, which was visually
                  // ambiguous in dark mode), plus a checkmark glyph so
                  // selection state is unambiguous even without color.
                  className={`flex min-w-[60px] items-center justify-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                    checked
                      ? "border-emerald-600 bg-emerald-600 text-white shadow-sm dark:border-emerald-500 dark:bg-emerald-600 dark:text-white"
                      : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-900"
                  }`}
                >
                  {checked && (
                    <span aria-hidden="true" className="text-[10px]">
                      ✓
                    </span>
                  )}
                  <span>{d.short}</span>
                </button>
              );
            })}
          </div>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="text-sm">Active (generate future occurrences)</span>
        </label>

        <div className="flex items-center justify-between gap-3">
          {error && (
            <span className="text-sm text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                disabled={pending}
                className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={onSubmit}
              disabled={pending}
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </div>

      {rules.length > 0 && (
        <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rules.map((r) => {
            const isEditing = editingId === r.id;
            return (
              <li
                key={r.id}
                className={
                  "flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm " +
                  (isEditing
                    ? "bg-neutral-50 dark:bg-neutral-900"
                    : "")
                }
              >
                <span className="flex items-baseline gap-3">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                      r.active
                        ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400"
                        : "bg-neutral-200 text-neutral-500 line-through dark:bg-neutral-800 dark:text-neutral-500"
                    }`}
                  >
                    {formatLabel(r.label)}
                  </span>
                  <span className="font-medium">
                    {formatDays(r.days_of_week)}
                  </span>
                  <span className="text-neutral-500">
                    {formatClockLabel(trimSeconds(r.start_local_time), timeFormat)} to{" "}
                    {formatClockLabel(trimSeconds(r.end_local_time), timeFormat)}
                  </span>
                  {capacityOn && (
                    <span className="text-[11px] text-neutral-400">
                      {scopeRowLabel(r.practitioner_id, directory)}
                    </span>
                  )}
                  {!r.active && (
                    <span className="text-neutral-400 italic">disabled</span>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onToggleActive(r)}
                    disabled={pending}
                    className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50 dark:hover:text-neutral-100"
                  >
                    {r.active ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit(r)}
                    disabled={pending}
                    className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50 dark:hover:text-neutral-100"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(r.id)}
                    disabled={pending}
                    className="text-xs text-neutral-500 hover:text-red-600 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

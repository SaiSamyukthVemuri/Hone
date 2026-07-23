"use client";

import { useState, useTransition } from "react";
import type { StudioTimedBlock } from "@/lib/types/database";
import {
  formatTimeForStudio,
  isAllDayInterval,
  type TimeFormat,
} from "@/lib/booking/tz";
import {
  createTimedBlockAction,
  deleteTimedBlockAction,
  updateTimedBlockAction,
} from "./actions";
import {
  ScopeField,
  scopeRowLabel,
  type ScopeDirectory,
  type ScopeSelectable,
  type ViewScope,
} from "./ScopeField";

type Props = {
  studioTimezone: string;
  // Migration 0109: 12h/24h preference for the DISPLAYED block times. The edit
  // form inputs stay 24h HH:MM (formatTimeForInput) — that is a machine value.
  timeFormat: TimeFormat;
  todayLocal: string;
  blocks: ReadonlyArray<StudioTimedBlock>;
  // Scope wiring (PR B 3E-6). Absent = Legacy studio: no scope selector, parent
  // has already filtered to studio-wide rows. A whole-day block always stays
  // studio-wide regardless of the selector.
  capacityOn?: boolean;
  viewScope?: ViewScope;
  selectable?: ReadonlyArray<ScopeSelectable>;
  directory?: ScopeDirectory;
};

const CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "lunch", label: "Lunch" },
  { value: "break", label: "Break" },
  { value: "meeting", label: "Meeting" },
  { value: "emergency", label: "Emergency" },
  { value: "personal", label: "Personal" },
  { value: "training", label: "Training" },
  { value: "admin", label: "Admin" },
  { value: "other", label: "Other" },
];

function formatCategory(c: string): string {
  return CATEGORIES.find((x) => x.value === c)?.label ?? c;
}

// Display formatting for the upcoming-blocks list. The time honors the studio's
// 12h/24h preference (migration 0109); the date is unchanged.
function formatLocal(
  iso: string,
  tz: string,
  format: TimeFormat,
): { date: string; time: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
  const time = formatTimeForStudio(d, tz, format);
  return { date, time };
}

// Form-input formatting (YYYY-MM-DD and HH:MM in studio tz). Used to
// prefill the edit form from an existing block's UTC instants.
function formatDateForInput(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
function formatTimeForInput(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

const DEFAULT_START = "12:00";
const DEFAULT_END = "12:30";
const DEFAULT_CATEGORY = "meeting";

export function TimedBlocksSection({
  studioTimezone,
  timeFormat,
  todayLocal,
  blocks,
  capacityOn = false,
  viewScope = { kind: "studio" },
  selectable = [],
  directory = {},
}: Props) {
  const defaultScope =
    viewScope.kind === "practitioner" ? viewScope.practitionerId : "";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [date, setDate] = useState(todayLocal);
  const [startLocal, setStartLocal] = useState(DEFAULT_START);
  const [endLocal, setEndLocal] = useState(DEFAULT_END);
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [privateNote, setPrivateNote] = useState("");
  const [scope, setScope] = useState<string>(defaultScope);
  // All-day toggle (create + edit). When checked the start/end inputs are
  // disabled and the action synthesises a full studio-local-day UTC range. On
  // edit it is pre-set from the block's stored local-midnight boundaries, so
  // editing preserves the mode; toggling converts all-day ↔ timed explicitly.
  const [allDay, setAllDay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function resetForm() {
    setEditingId(null);
    setDate(todayLocal);
    setStartLocal(DEFAULT_START);
    setEndLocal(DEFAULT_END);
    setCategory(DEFAULT_CATEGORY);
    setPrivateNote("");
    setAllDay(false);
    setScope(defaultScope);
    setError(null);
  }

  function onSubmit() {
    setError(null);
    const fd = new FormData();
    fd.set("date", date);
    fd.set("start_local", startLocal);
    fd.set("end_local", endLocal);
    fd.set("category", category);
    fd.set("private_note", privateNote);
    // Send all_day on create AND edit — the update action now honours it, so
    // editing an all-day block keeps it all-day and toggling converts modes.
    if (allDay) {
      fd.set("all_day", "true");
    }
    // Send the explicit scope whenever capacity is on — INCLUDING whole-day
    // blocks, which may be scoped to one practitioner (their whole day off) or
    // studio-wide (All practitioners).
    if (capacityOn) {
      fd.set("practitioner_id", scope);
    }

    if (editingId) {
      fd.set("id", editingId);
    }
    startTransition(async () => {
      try {
        const result = editingId
          ? await updateTimedBlockAction(fd)
          : await createTimedBlockAction(fd);
        if (!result.ok) {
          // Typed-result path: the action returned a specific
          // owner-facing message (e.g. the appointment-overlap
          // explanation). Show it inline rather than relying on a
          // thrown Server Action exception, which Next.js masks
          // to a generic error in production.
          setError(result.error);
          return;
        }
        resetForm();
      } catch (e) {
        // Unexpected exception (RLS, network, etc). The
        // expected-error paths inside the action return typed
        // results above; anything reaching here is a true crash.
        setError(
          e instanceof Error
            ? e.message
            : editingId
              ? "Failed to update block."
              : "Failed to add block.",
        );
      }
    });
  }

  function onEdit(b: StudioTimedBlock) {
    setEditingId(b.id);
    setDate(formatDateForInput(b.starts_at, studioTimezone));
    // Detect all-day by the stored local-midnight boundaries (never by 24h
    // duration), so editing an all-day block PRESERVES all-day mode. A timed
    // block prefills its explicit times.
    const wasAllDay = isAllDayInterval(b.starts_at, b.ends_at, studioTimezone);
    setAllDay(wasAllDay);
    setStartLocal(wasAllDay ? DEFAULT_START : formatTimeForInput(b.starts_at, studioTimezone));
    setEndLocal(wasAllDay ? DEFAULT_END : formatTimeForInput(b.ends_at, studioTimezone));
    setCategory(b.category);
    setPrivateNote(b.private_note ?? "");
    setScope(b.practitioner_id ?? "");
    setError(null);
  }

  function onDelete(id: string) {
    const fd = new FormData();
    fd.set("id", id);
    startTransition(async () => {
      try {
        const result = await deleteTimedBlockAction(fd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (editingId === id) {
          resetForm();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete block.");
      }
    });
  }

  const submitLabel = editingId
    ? pending
      ? "Saving…"
      : "Save changes"
    : pending
      ? "Saving…"
      : "Add block";

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-medium">Block time</h2>
        <p className="mt-1 text-sm text-neutral-500">
          One-off lunch, meeting, emergency, or personal time. Block details
          and notes are private to your studio; clients only see the slot as
          unavailable.
        </p>
      </div>

      <div className="grid gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 md:grid-cols-[1fr_1fr_1fr_1fr] dark:border-neutral-800 dark:bg-neutral-900">
        {editingId && (
          <div className="md:col-span-4 -mt-1 rounded bg-neutral-100 px-2 py-1 text-xs uppercase tracking-wider text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            Editing block
          </div>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Date
          </span>
          <input
            type="date"
            value={date}
            min={todayLocal}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        {/* All-day toggle (create AND edit). When checked the start/end inputs
            are disabled and the action synthesises a full studio-local-day UTC
            range. On edit it is pre-checked for an all-day block (detected by
            local-midnight boundaries), so editing preserves the mode; toggling
            it explicitly converts all-day ↔ timed. */}
        <label className="flex items-start gap-2 self-end text-xs md:col-span-1">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            className="mt-0.5 h-4 w-4 flex-none rounded border-neutral-400"
          />
          <span className="flex flex-col">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              All day
            </span>
            <span className="text-[11px] text-neutral-500">
              Block the entire day
            </span>
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Start
          </span>
          <input
            type="time"
            value={startLocal}
            step={300}
            disabled={allDay}
            onChange={(e) => setStartLocal(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
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
            disabled={allDay}
            onChange={(e) => setEndLocal(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Category
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {capacityOn && (
          <div className="md:col-span-2">
            {/* Usable for all-day too: a whole-day block can be one
                practitioner's day off or studio-wide (All practitioners). */}
            <ScopeField
              value={scope}
              onChange={setScope}
              selectable={selectable}
              directory={directory}
              disabled={pending}
            />
          </div>
        )}
        <label className="flex flex-col gap-1.5 md:col-span-4">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Private note (optional)
          </span>
          <input
            type="text"
            value={privateNote}
            onChange={(e) => setPrivateNote(e.target.value)}
            placeholder="Not shown to clients"
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <div className="md:col-span-4 flex items-center justify-between gap-3">
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

      {blocks.length > 0 && (
        <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {blocks.map((b) => {
            const startFmt = formatLocal(b.starts_at, studioTimezone, timeFormat);
            const endFmt = formatLocal(b.ends_at, studioTimezone, timeFormat);
            const isEditing = editingId === b.id;
            return (
              <li
                key={b.id}
                className={
                  "flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm " +
                  (isEditing
                    ? "bg-neutral-50 dark:bg-neutral-900"
                    : "")
                }
              >
                <span className="flex items-baseline gap-3">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                    {formatCategory(b.category)}
                  </span>
                  <span className="font-medium">{startFmt.date}</span>
                  <span className="text-neutral-500">
                    {startFmt.time} to {endFmt.time}
                  </span>
                  {capacityOn && (
                    <span className="text-[11px] text-neutral-400">
                      {scopeRowLabel(b.practitioner_id, directory)}
                    </span>
                  )}
                  {b.private_note && (
                    <span className="text-neutral-500 italic">
                      {b.private_note}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onEdit(b)}
                    disabled={pending}
                    className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50 dark:hover:text-neutral-100"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(b.id)}
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

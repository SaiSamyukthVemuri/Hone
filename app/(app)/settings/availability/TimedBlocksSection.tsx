"use client";

import { useState, useTransition } from "react";
import type { StudioTimedBlock } from "@/lib/types/database";
import {
  createTimedBlockAction,
  deleteTimedBlockAction,
} from "./actions";

type Props = {
  studioTimezone: string;
  todayLocal: string;
  ninetyDaysOut: string;
  blocks: ReadonlyArray<StudioTimedBlock>;
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

function formatLocal(iso: string, tz: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return { date, time };
}

export function TimedBlocksSection({
  studioTimezone,
  todayLocal,
  ninetyDaysOut,
  blocks,
}: Props) {
  const [date, setDate] = useState(todayLocal);
  const [startLocal, setStartLocal] = useState("12:00");
  const [endLocal, setEndLocal] = useState("12:30");
  const [category, setCategory] = useState("meeting");
  const [privateNote, setPrivateNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onCreate() {
    setError(null);
    const fd = new FormData();
    fd.set("date", date);
    fd.set("start_local", startLocal);
    fd.set("end_local", endLocal);
    fd.set("category", category);
    fd.set("private_note", privateNote);
    startTransition(async () => {
      try {
        await createTimedBlockAction(fd);
        setPrivateNote("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to add block.");
      }
    });
  }

  function onDelete(id: string) {
    const fd = new FormData();
    fd.set("id", id);
    startTransition(async () => {
      try {
        await deleteTimedBlockAction(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete block.");
      }
    });
  }

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
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Date
          </span>
          <input
            type="date"
            value={date}
            min={todayLocal}
            max={ninetyDaysOut}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
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
          <button
            type="button"
            onClick={onCreate}
            disabled={pending}
            className="ml-auto rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {pending ? "Saving…" : "Add block"}
          </button>
        </div>
      </div>

      {blocks.length > 0 && (
        <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {blocks.map((b) => {
            const startLocalFmt = formatLocal(b.starts_at, studioTimezone);
            const endLocalFmt = formatLocal(b.ends_at, studioTimezone);
            return (
              <li
                key={b.id}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm"
              >
                <span className="flex items-baseline gap-3">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                    {formatCategory(b.category)}
                  </span>
                  <span className="font-medium">{startLocalFmt.date}</span>
                  <span className="text-neutral-500">
                    {startLocalFmt.time} to {endLocalFmt.time}
                  </span>
                  {b.private_note && (
                    <span className="text-neutral-500 italic">
                      {b.private_note}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => onDelete(b.id)}
                  disabled={pending}
                  className="text-xs text-neutral-500 hover:text-red-600 disabled:opacity-50"
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

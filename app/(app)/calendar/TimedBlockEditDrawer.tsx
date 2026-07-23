"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StudioTimedBlock } from "@/lib/types/database";
import { TIMED_BLOCK_LABEL } from "./calendar-format";
import {
  formatClockLabel,
  isAllDayInterval,
  type TimeFormat,
} from "@/lib/booking/tz";
import {
  updateTimedBlockAction,
  deleteTimedBlockAction,
} from "@/app/(app)/settings/availability/actions";

// Edit/delete a one-off timed block from the calendar (PR C). REUSES the
// existing owner-gated Settings actions (updateTimedBlockAction /
// deleteTimedBlockAction) — no new server action, no migration, no RLS change.
// Owner-only edit/delete (the actions enforce assertOwnerWithStudio server-side
// AND owner-only RLS); non-owners see a read-only detail panel. Recurring breaks
// are NOT edited here — only one-off studio_timed_blocks.

// Machine-value formatters (24h HH:MM + YYYY-MM-DD in the studio tz), matching
// the Settings block editor so updateTimedBlockAction receives the same shape.
function dateForInput(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function timeForInput(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

const CATEGORY_OPTIONS = Object.entries(TIMED_BLOCK_LABEL).map(([value, label]) => ({
  value,
  label,
}));

export function TimedBlockEditDrawer({
  block,
  isOwner,
  studioTimezone,
  timeFormat,
  onClose,
}: {
  block: StudioTimedBlock | null;
  isOwner: boolean;
  studioTimezone: string;
  timeFormat: TimeFormat;
  onClose: () => void;
}) {
  const router = useRouter();
  const [date, setDate] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [category, setCategory] = useState("other");
  const [privateNote, setPrivateNote] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!block) return;
    // Seed the form from the block. Detect all-day by its local-midnight
    // boundaries (never by 24h duration) so editing preserves the mode; a timed
    // block seeds explicit times.
    setDate(dateForInput(block.starts_at, studioTimezone));
    const ad = isAllDayInterval(block.starts_at, block.ends_at, studioTimezone);
    setAllDay(ad);
    setStartLocal(ad ? "12:00" : timeForInput(block.starts_at, studioTimezone));
    setEndLocal(ad ? "12:30" : timeForInput(block.ends_at, studioTimezone));
    setCategory(block.category);
    setPrivateNote(block.private_note ?? "");
    setError(null);
    setConfirmingDelete(false);
  }, [block, studioTimezone]);

  useEffect(() => {
    if (!block) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [block, onClose]);

  if (!block) return null;

  function handleSave() {
    setError(null);
    const fd = new FormData();
    fd.set("id", block!.id);
    fd.set("date", date);
    fd.set("start_local", startLocal);
    fd.set("end_local", endLocal);
    fd.set("category", category);
    fd.set("private_note", privateNote);
    // Preserve/convert all-day. Scope (practitioner_id) is intentionally NOT
    // sent — updateTimedBlockAction loads the existing row and preserves it.
    if (allDay) fd.set("all_day", "true");
    startTransition(async () => {
      const r = await updateTimedBlockAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  function handleDelete() {
    setError(null);
    const fd = new FormData();
    fd.set("id", block!.id);
    startTransition(async () => {
      try {
        const result = await deleteTimedBlockAction(fd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not delete this block.");
      }
    });
  }

  const label = TIMED_BLOCK_LABEL[block.category] ?? "Unavailable";
  // Displayed range honors the studio 12h/24h preference; the inputs above stay
  // 24h machine values. An all-day block reads "All day" rather than 00:00–00:00.
  const rangeLabel = isAllDayInterval(block.starts_at, block.ends_at, studioTimezone)
    ? "All day"
    : `${formatClockLabel(timeForInput(block.starts_at, studioTimezone), timeFormat)}–${formatClockLabel(timeForInput(block.ends_at, studioTimezone), timeFormat)}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Blocked time"
      className="fixed inset-0 z-50 flex items-stretch justify-end"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
      />
      <div
        className="relative z-10 flex w-full max-w-sm flex-col gap-4 overflow-y-auto bg-white p-6 shadow-xl dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold">Blocked time</h2>
          <p className="text-sm text-neutral-500">
            {label} · {rangeLabel}
          </p>
        </header>

        {!isOwner ? (
          // Read-only for non-owners: the server actions are owner-gated
          // (assertOwnerWithStudio + owner-only RLS), so edit/delete are never
          // exposed here — they would be rejected.
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
            Only studio owners can edit or remove blocked time. Your studio owner
            can manage blocks in Settings → Availability.
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Date</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
                className="h-4 w-4 rounded border-neutral-400"
              />
              <span className="font-medium">All day</span>
              <span className="text-xs text-neutral-500">Block the entire day</span>
            </label>
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1 text-sm">
                <span className="font-medium">Start</span>
                <input
                  type="time"
                  value={startLocal}
                  disabled={allDay}
                  onChange={(e) => setStartLocal(e.target.value)}
                  className="rounded-md border border-neutral-300 px-3 py-2 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-sm">
                <span className="font-medium">End</span>
                <input
                  type="time"
                  value={endLocal}
                  disabled={allDay}
                  onChange={(e) => setEndLocal(e.target.value)}
                  className="rounded-md border border-neutral-300 px-3 py-2 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
              >
                {CATEGORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Private note (optional)</span>
              <textarea
                rows={2}
                value={privateNote}
                onChange={(e) => setPrivateNote(e.target.value)}
                className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            <div className="mt-2 flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={pending}
                onClick={handleSave}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                {pending ? "Saving…" : "Save"}
              </button>
              {confirmingDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500">Delete this block?</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={handleDelete}
                    className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="text-xs text-neutral-500 underline"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmingDelete(true)}
                  className="text-sm text-red-600 underline dark:text-red-400"
                >
                  Delete
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

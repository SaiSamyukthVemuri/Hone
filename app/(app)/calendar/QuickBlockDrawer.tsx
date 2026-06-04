"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createCalendarTimedBlockAction } from "./calendar-block-actions";

// PR #139. Quick block drawer. Opens from the drag-action chooser
// when the practitioner picks "Block time" on a drag-created range.
// Reuses the visual shell of QuickBookDrawer but with a much smaller
// form: date (read-only from the drag), start, end, optional reason.
// Submits to createCalendarTimedBlockAction which writes a
// studio_timed_blocks row scoped to the resolved studio. No category
// picker: the action defaults to 'other' so the row remains
// re-categorisable from Settings -> Breaks & blocks.

export type QuickBlockDraft = {
  // YYYY-MM-DD in studio local
  localDate: string;
  // HH:MM
  startLocal: string;
  // HH:MM
  endLocal: string;
};

const REASON_MAX = 200;

export function QuickBlockDrawer({
  open,
  draft,
  studioTimezone,
  onClose,
}: {
  open: boolean;
  draft: QuickBlockDraft | null;
  studioTimezone: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startSubmit] = useTransition();

  // Reset whenever the drawer opens (or a fresh drag arrives).
  useEffect(() => {
    if (!open || !draft) {
      setStart("");
      setEnd("");
      setReason("");
      setError(null);
      return;
    }
    setStart(draft.startLocal);
    setEnd(draft.endLocal);
    setReason("");
    setError(null);
  }, [open, draft?.localDate, draft?.startLocal, draft?.endLocal, draft]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !draft) return null;

  function submit() {
    if (!draft) return;
    setError(null);
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      setError("Times must be in HH:MM format.");
      return;
    }
    if (start >= end) {
      setError("End time must be after start time.");
      return;
    }
    if (reason.length > REASON_MAX) {
      setError(`Reason must be ${REASON_MAX} characters or fewer.`);
      return;
    }
    const fd = new FormData();
    fd.set("date", draft.localDate);
    fd.set("start_local", start);
    fd.set("end_local", end);
    fd.set("reason", reason.trim());
    startSubmit(async () => {
      const r = await createCalendarTimedBlockAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Server revalidatePath('/calendar') flips the page; close the
      // drawer here so the practitioner sees the new block land in
      // the column.
      onClose();
      router.refresh();
    });
  }

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Block time"
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto bg-white p-6 shadow-xl dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">Block time</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-neutral-500 underline"
          >
            Close
          </button>
        </header>

        <p className="text-xs text-neutral-500">
          Blocked time prevents new bookings here. {studioTimezone} time.
        </p>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            Date
          </span>
          <p className="text-sm font-medium tabular-nums">{draft.localDate}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Start
            </span>
            <input
              type="time"
              step={900}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              End
            </span>
            <input
              type="time"
              step={900}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            Reason (optional)
          </span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={REASON_MAX}
            placeholder="e.g. dentist, training, busy"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <span className="text-[11px] text-neutral-500">
            Visible only to studio members; never shown to clients.
          </span>
        </label>

        {error && (
          <p className="text-xs text-red-700 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {pending ? "Saving..." : "Save block"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
        </div>
      </aside>
    </div>
  );
}

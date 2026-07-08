"use client";

import { useEffect } from "react";
import {
  formatClockLabel,
  formatLocalDateLabel,
  type TimeFormat,
} from "@/lib/booking/tz";

// PR #139. Centred chooser that appears after a drag-to-create
// selection on the calendar. The drag itself produces a
// (date, start, durationMinutes) draft; this component asks the
// practitioner whether they want to book an appointment or block
// the time. Bare clicks (no drag duration) skip the chooser and
// go straight to QuickBookDrawer (the historical click-empty-slot
// behaviour).

export type DragRangeDraft = {
  localDate: string;
  startLocal: string;
  endLocal: string;
};

export function DragActionChooser({
  open,
  draft,
  timeFormat,
  onBook,
  onBlock,
  onCancel,
}: {
  open: boolean;
  draft: DragRangeDraft | null;
  // Studio 12h/24h preference (migration 0109). Formats the DISPLAYED range
  // only; draft.startLocal/endLocal stay 24h HH:MM machine values for submit.
  timeFormat: TimeFormat;
  onBook: () => void;
  onBlock: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open || !draft) return null;

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Choose action for selected time"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
    >
      <div
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">
            What would you like to do?
          </h2>
          <p className="text-xs text-neutral-500 tabular-nums">
            {formatLocalDateLabel(draft.localDate)} ·{" "}
            {formatClockLabel(draft.startLocal, timeFormat)} to{" "}
            {formatClockLabel(draft.endLocal, timeFormat)}
          </p>
        </header>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onBook}
            className="rounded-md bg-neutral-900 px-4 py-3 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900"
          >
            Book appointment
          </button>
          <button
            type="button"
            onClick={onBlock}
            className="rounded-md border border-neutral-300 px-4 py-3 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
          >
            Block time
          </button>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="self-end text-xs text-neutral-500 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

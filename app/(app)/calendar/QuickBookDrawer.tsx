"use client";

// Phase A read-only quick-book drawer.
//
// This component is intentionally non-functional. It:
//   - displays the studio-local date + time inferred from a click
//     on an empty calendar cell
//   - has a single "Close" button + Esc keyboard handler + backdrop
//     click handler
//   - does NOT call any server action
//   - does NOT contain any form
//   - does NOT submit anything
//   - does NOT touch any booking, slot, or appointment logic
//
// Phase B will add client search + service picker + the actual
// bookAppointmentForClientAction call. Until then this surface is
// a UI placeholder so the calendar-first interaction pattern can
// be wired in isolation.

import { useEffect } from "react";

export type QuickBookDraft = {
  // YYYY-MM-DD in studio local time
  localDate: string;
  // HH:MM in studio local time, snapped to 15-minute increments
  localTime: string;
};

type Props = {
  open: boolean;
  draft: QuickBookDraft | null;
  onClose: () => void;
};

// Format a YYYY-MM-DD studio-local date as "Tuesday, May 26 2026"
// without timezone surprises. Constructed from explicit y/m/d so the
// visitor's local-time offset can't shift it.
function formatLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return localDate;
  }
  const dt = new Date(y, m - 1, d);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

// "14:30" -> "2:30 PM" in en-US default. Re-uses the runtime's
// Intl formatter so behavior matches the visitor's locale.
function formatLocalTime(localTime: string): string {
  const [hStr, mStr] = localTime.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return localTime;
  const dt = new Date(2000, 0, 1, h, m, 0);
  return dt.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function QuickBookDrawer({ open, draft, onClose }: Props) {
  // Close on Esc. Listener is attached only while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !draft) return null;

  const formattedDate = formatLocalDate(draft.localDate);
  const formattedTime = formatLocalTime(draft.localTime);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New appointment draft"
      className="fixed inset-0 z-50 flex items-stretch justify-end"
    >
      {/* Backdrop. Click closes. */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
      />

      {/* Drawer panel. Full-width on mobile, fixed width on desktop.
          Slide-in animation kept minimal so the calm visual tone
          matches the rest of Hone. */}
      <div className="relative flex h-full w-full flex-col gap-6 overflow-y-auto bg-white p-6 shadow-xl dark:bg-neutral-950 sm:w-[420px]">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500">
              New appointment
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">
              {formattedDate}
            </h2>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {formattedTime}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            Esc
          </button>
        </header>

        <section className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-5 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
          <p className="font-medium text-neutral-800 dark:text-neutral-200">
            Client and service selection comes next.
          </p>
          <p className="mt-2">
            Phase A wires the click target on the calendar. The next phase
            adds client search, service picker, and the actual booking
            action.
          </p>
        </section>

        <footer className="mt-auto flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

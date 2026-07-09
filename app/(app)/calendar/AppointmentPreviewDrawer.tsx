"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
import { formatTimeForStudio, type TimeFormat } from "@/lib/booking/tz";
import { appointmentDisplayStatus } from "./appointment-display-status";
import { timeRangeLabel, weekdayLabel, monthDayLabel } from "./calendar-format";

// In-context appointment PREVIEW (desktop PR C-lite). Opened from an appointment
// card on the desktop week grid so a practitioner can inspect a booking WITHOUT
// navigating away — the on-grid equivalent of clicking a Google/Apple Calendar
// event. It is strictly READ-ONLY: it shows only safe summary fields the
// calendar page already loaded (client name, service, date/time, status), plus
// an "Open full details" deep link to the unchanged /calendar/[id] route. It
// runs no new query and exposes no editing or lifecycle actions — those all
// stay on the detail route.

type Props = {
  appointment: AppointmentWithPractitionerColor | null;
  studioTimezone: string;
  timeFormat: TimeFormat;
  // Preserves the calendar's return-to-this-week behaviour on the deep link.
  returnTo: string;
  onClose: () => void;
};

// Weekday + month/day for a studio-local instant (display only).
function dayLabel(iso: string, tz: string): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: undefined,
  }).format(new Date(iso)); // YYYY-MM-DD in studio tz
  const dow = new Date(`${local}T12:00:00Z`).getUTCDay();
  return `${weekdayLabel(dow)}, ${monthDayLabel(local)}`;
}

export function AppointmentPreviewDrawer({
  appointment,
  studioTimezone,
  timeFormat,
  returnTo,
  onClose,
}: Props) {
  useEffect(() => {
    if (!appointment) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [appointment, onClose]);

  if (!appointment) return null;

  const a = appointment;
  const start = new Date(a.starts_at);
  const dispStart = formatTimeForStudio(start, studioTimezone, timeFormat);
  const dispEnd = a.ends_at
    ? formatTimeForStudio(new Date(a.ends_at), studioTimezone, timeFormat)
    : null;
  const timeRange = timeRangeLabel(dispStart, dispEnd);
  const clientName = a.client?.name?.trim() || "Client";
  const serviceName = a.service?.name?.trim() || null;
  const modality = a.service?.modality?.trim() || null;

  const ds = appointmentDisplayStatus(a.status, a.ends_at);
  const statusLabel =
    ds === "done"
      ? "Done"
      : ds === "completed"
        ? "Completed"
        : ds === "no_show"
          ? "No-show"
          : "Upcoming";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Appointment preview"
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
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-base font-semibold">{clientName}</h2>
            <p className="text-sm text-neutral-500">
              {dayLabel(a.starts_at, studioTimezone)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Close
          </button>
        </header>

        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500">Time</dt>
            <dd className="text-right font-medium tabular-nums">
              {timeRange} · {a.duration_minutes}m
            </dd>
          </div>
          {serviceName && (
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500">Service</dt>
              <dd className="text-right font-medium">
                {serviceName}
                {modality ? ` · ${modality}` : ""}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500">Status</dt>
            <dd className="text-right font-medium">{statusLabel}</dd>
          </div>
        </dl>

        {/* The full editor + every appointment action live on the unchanged
            detail route — never duplicated here. */}
        <Link
          href={`/calendar/${a.id}${returnTo}`}
          className="mt-1 inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Open full details
        </Link>
      </div>
    </div>
  );
}

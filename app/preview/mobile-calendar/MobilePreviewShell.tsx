"use client";

import { useState } from "react";
import type { MobileDayData } from "@/app/(app)/calendar/CalendarMobileDayView";
import { MobileDayTimeline } from "@/app/(app)/calendar/MobileDayTimeline";
import type { TimeFormat } from "@/lib/booking/tz";

// PREVIEW-ONLY movement harness for the mobile calendar. Renders the REAL
// MobileDayTimeline (so scroll, positioning, cards, and the now-line are the
// actual PR #380 behaviour) inside the real single-vertical-scroll + day-nav
// model — but with NO auth, NO real data, and NO booking/edit drawers (taps just
// show a note). It exists to let the calendar's *movement* be tested on a phone
// without signing in. The route that renders this 404s in production.

type Props = {
  days: MobileDayData[];
  initialDate: string;
  today: string;
  tz: string;
  timeFormat: TimeFormat;
};

export function MobilePreviewShell({
  days,
  initialDate,
  today,
  tz,
  timeFormat,
}: Props) {
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [note, setNote] = useState<string | null>(null);

  const idx = Math.max(
    0,
    days.findIndex((d) => d.date === selectedDate),
  );
  const day = days[idx];
  if (!day) return null;

  const goPrev = () => idx > 0 && setSelectedDate(days[idx - 1].date);
  const goNext = () =>
    idx < days.length - 1 && setSelectedDate(days[idx + 1].date);
  const goToday = () => {
    const ti = days.findIndex((d) => d.date === today);
    if (ti >= 0) setSelectedDate(today);
  };

  return (
    <div className="mx-auto max-w-md px-4 py-4">
      <div className="mb-2 rounded-md bg-amber-100 px-3 py-2 text-[12px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
        Preview mode · fake data · no login. Testing the mobile calendar
        movement for PR #380. Booking/edit is disabled here.
      </div>

      <div className="sticky top-0 z-20 border-b border-neutral-200 bg-white/95 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">
              {day.weekdayShort}, {day.monthDayLabel}
            </div>
            <div className="text-[11px] text-neutral-500">{tz}</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={goToday}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700"
            >
              Today
            </button>
            <button
              type="button"
              aria-label="Previous day"
              onClick={goPrev}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 text-lg dark:border-neutral-700"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Next day"
              onClick={goNext}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 text-lg dark:border-neutral-700"
            >
              ›
            </button>
          </div>
        </div>
        <div className="mt-2 flex gap-1">
          {days.map((d) => {
            const selected = d.date === selectedDate;
            return (
              <button
                key={d.date}
                type="button"
                onClick={() => setSelectedDate(d.date)}
                aria-pressed={selected}
                className={
                  "flex flex-1 flex-col items-center rounded-md py-1 text-[11px] leading-tight " +
                  (selected
                    ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                    : d.isToday
                      ? "bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100"
                      : "text-neutral-600 dark:text-neutral-300")
                }
              >
                <span className="font-medium uppercase">{d.weekdayShort}</span>
                <span className="tabular-nums">
                  {d.monthDayLabel.replace(/^[A-Za-z]+\s/, "")}
                </span>
              </button>
            );
          })}
        </div>
        {note && (
          <div className="mt-2 rounded-md bg-neutral-200/80 px-2 py-1 text-[11px] text-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-200">
            {note}
          </div>
        )}
      </div>

      <div className="mt-2 max-h-[calc(100dvh-13rem)] overflow-y-auto overscroll-contain rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <MobileDayTimeline
          date={day.date}
          appts={day.appts}
          timedBlocks={day.timedBlocks}
          recurringBreaks={day.recurringBreaks}
          availability={day.availability}
          closedDay={day.closedDay}
          isToday={day.isToday}
          tz={tz}
          timeFormat={timeFormat}
          returnTo=""
          onBookAt={(t) => setNote(`Tapped empty time → would book at ${t}`)}
          onEditBlock={() => setNote("Tapped a block → would open block editor")}
        />
      </div>

      <button
        type="button"
        aria-label="Add appointment"
        onClick={() => setNote("Floating + → would open quick-book")}
        className="fixed bottom-6 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-neutral-900 text-3xl font-light text-white shadow-lg dark:bg-white dark:text-neutral-900"
      >
        +
      </button>
    </div>
  );
}

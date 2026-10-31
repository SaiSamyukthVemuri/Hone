"use client";

import Link from "next/link";
import { useState } from "react";
import {
  dayOfMonth,
  firstOfNextMonthString,
  firstOfPreviousMonthString,
  isInMonth,
  monthGridDates,
  monthYearLabel,
} from "@/lib/booking/month-grid";
import { miniCalendarHref, withSelection } from "@/lib/calendar/practitioner-selection";

// HON-48 sidebar mini month. Picking a date navigates the CURRENT view to it (day -> that day,
// week -> the week containing it, month -> its month) and keeps the practitioner selection. The
// month shown here is local state: paging it navigates nowhere. Dates are studio-local day keys
// (`today` and `selectedDate` come from the server in the STUDIO timezone and this file never builds
// a Date), so the browser's timezone cannot shift a cell or move a mark. Two marks, both may apply
// to one day: TODAY (a ring) and the SELECTED date (a filled disc). "Today" goes to today in the
// current view.

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;

export function CalendarMiniMonth({
  anchorDate,
  selectedDate,
  today,
  view,
  selectionParam,
}: {
  /** Which month the mini calendar opens on. */
  anchorDate: string;
  /** The date the current view is on; null when the view has no single date (Month). */
  selectedDate: string | null;
  today: string;
  view: "day" | "week" | "month";
  selectionParam: string | undefined;
}) {
  const [shown, setShown] = useState(anchorDate);
  const cells = monthGridDates(shown);
  return (
    <section data-testid="calendar-mini-month" aria-label="Pick a date" className="select-none">
      <div className="mb-1 flex items-center justify-between">
        <button
          type="button"
          data-testid="calendar-mini-prev"
          aria-label="Previous month"
          onClick={() => setShown(firstOfPreviousMonthString(shown))}
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          ‹
        </button>
        <div className="flex items-center gap-2">
          <div data-testid="calendar-mini-label" className="text-sm font-medium">
            {monthYearLabel(shown)}
          </div>
          <Link
            href={withSelection(miniCalendarHref(view, today), selectionParam)}
            data-testid="calendar-mini-today"
            onClick={() => setShown(today)}
            className="rounded-md border border-neutral-300 px-2 py-0.5 text-[11px] font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Today
          </Link>
        </div>
        <button
          type="button"
          data-testid="calendar-mini-next"
          aria-label="Next month"
          onClick={() => setShown(firstOfNextMonthString(shown))}
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase text-neutral-500" aria-hidden="true">
        {WEEKDAYS.map((d, i) => (
          <div key={i} className="py-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center text-xs">
        {cells.map((date) => {
          const inMonth = isInMonth(date, shown);
          const isToday = date === today;
          const isAnchor = selectedDate !== null && date === selectedDate;
          return (
            <Link
              key={date}
              href={withSelection(miniCalendarHref(view, date), selectionParam)}
              data-testid="calendar-mini-day"
              data-date={date}
              data-mini-today={isToday ? "true" : undefined}
              data-mini-selected={isAnchor ? "true" : undefined}
              aria-label={`${date}${isToday ? ", today" : ""}${isAnchor ? ", selected" : ""}`}
              aria-current={isAnchor ? "date" : undefined}
              className={[
                "mx-auto my-0.5 flex h-7 w-7 items-center justify-center rounded-full tabular-nums",
                isAnchor ? "bg-sky-600 font-semibold text-white dark:bg-sky-500" : "",
                isToday ? "ring-2 ring-sky-600 ring-offset-1 ring-offset-white dark:ring-sky-400 dark:ring-offset-neutral-950" : "",
                isToday && !isAnchor ? "font-semibold text-sky-700 dark:text-sky-300" : "",
                !isAnchor && !isToday
                  ? inMonth
                    ? "text-neutral-800 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900"
                    : "text-neutral-400 hover:bg-neutral-100 dark:text-neutral-600 dark:hover:bg-neutral-900"
                  : "",
              ].join(" ")}
            >
              {dayOfMonth(date)}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

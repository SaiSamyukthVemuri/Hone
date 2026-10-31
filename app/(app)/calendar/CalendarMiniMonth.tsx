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
// month shown here is local state: paging it navigates nowhere. Dates are studio-local day keys,
// so no device timezone shifts a cell.

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;

export function CalendarMiniMonth({
  anchorDate,
  today,
  view,
  selectionParam,
}: {
  anchorDate: string;
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
        <div data-testid="calendar-mini-label" className="text-sm font-medium">
          {monthYearLabel(shown)}
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
          const isAnchor = date === anchorDate;
          return (
            <Link
              key={date}
              href={withSelection(miniCalendarHref(view, date), selectionParam)}
              data-testid="calendar-mini-day"
              data-date={date}
              aria-label={date}
              aria-current={isAnchor ? "date" : undefined}
              className={[
                "mx-auto my-0.5 flex h-7 w-7 items-center justify-center rounded-full tabular-nums",
                isAnchor
                  ? "bg-sky-600 font-semibold text-white dark:bg-sky-500"
                  : isToday
                    ? "font-semibold text-sky-700 ring-1 ring-sky-600 dark:text-sky-300"
                    : inMonth
                      ? "text-neutral-800 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900"
                      : "text-neutral-400 hover:bg-neutral-100 dark:text-neutral-600 dark:hover:bg-neutral-900",
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

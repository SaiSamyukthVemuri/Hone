import Link from "next/link";
import { localDateString, startOfWeek } from "@/lib/booking/tz";
import {
  dayOfMonth,
  isInMonth,
  monthGridDates,
  monthYearLabel,
} from "@/lib/booking/month-grid";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
import { serviceCardClasses } from "@/lib/calendar/service-colors";
import { appointmentDisplayStatus } from "./appointment-display-status";

// Server component. Renders the 6-row Sunday-start month grid for
// the given monthAnchor (YYYY-MM-DD, normalized to first-of-month by
// the caller). Appointments are passed in already filtered to the
// visible range and grouped by their local date in studio tz.
//
// Per-day cell shows:
//   * day-of-month (top-right corner)
//   * appointment chips, up to 3 visible + a "+N more" pill
//   * today highlight (faint sky tint, same hue as the week view's
//     today column)
//   * spillover days (previous/next month) softened
//   * closed-day muted background
//
// Clicking a day navigates to the week view centered on that date
// (?view=week&week=startOfWeek(date)). Clicking is the ONLY action
// in the month view; there is no booking, no drag, no edit. The
// month view is a navigation/orientation surface only.

type ClosedDayLookup = (date: string) => boolean;

type MonthDayAppt = Pick<
  AppointmentWithPractitionerColor,
  "id" | "status" | "starts_at" | "ends_at" | "service"
> & {
  localTime: string;
};

const MAX_CHIPS_PER_DAY = 3;

export function MonthView({
  monthAnchor,
  appointmentsByDate,
  today,
  isClosedDate,
}: {
  monthAnchor: string;
  appointmentsByDate: Map<string, MonthDayAppt[]>;
  today: string;
  isClosedDate: ClosedDayLookup;
}) {
  const cells = monthGridDates(monthAnchor);
  const monthLabel = monthYearLabel(monthAnchor);
  const weekdayHeaders: ReadonlyArray<string> = [
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
  ];

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
      <div className="border-b border-neutral-200 bg-neutral-50/70 dark:border-neutral-800 dark:bg-neutral-900/50">
        <div className="grid grid-cols-7">
          {weekdayHeaders.map((label) => (
            <div
              key={label}
              className="border-l border-neutral-100 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500 first:border-l-0 dark:border-neutral-800/60 dark:text-neutral-400"
            >
              {label}
            </div>
          ))}
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        {monthLabel}
      </div>
      {/* 6 rows of 7 cells = 42 cells, constant across months. */}
      <div className="grid grid-cols-7">
        {cells.map((cellDate) => {
          const inMonth = isInMonth(cellDate, monthAnchor);
          const isTodayCell = cellDate === today;
          const closed = isClosedDate(cellDate);
          const dayAppts = appointmentsByDate.get(cellDate) ?? [];
          // The week view URL the day click navigates to. Snap the
          // clicked date to its containing week so the week view
          // header carries a consistent start, exactly matching what
          // the week prev/next links pass.
          const weekHref = `/calendar?view=week&week=${startOfWeek(cellDate)}`;
          return (
            <Link
              key={cellDate}
              href={weekHref}
              aria-label={`Open week of ${cellDate}`}
              className={[
                // Border + min height to keep the grid even across
                // months that need 5 or 6 visible weeks.
                "relative flex min-h-[112px] flex-col gap-1 border-b border-l border-neutral-100 px-2 py-1.5 transition-colors first:border-l-0 dark:border-neutral-800/60",
                "hover:bg-neutral-50 dark:hover:bg-neutral-900",
                isTodayCell ? "bg-sky-50/70 dark:bg-sky-950/25" : "",
                !inMonth
                  ? "bg-neutral-50/40 dark:bg-neutral-900/40 opacity-70"
                  : "",
                closed && inMonth
                  ? "bg-neutral-100/60 dark:bg-neutral-900/50"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="flex items-baseline justify-between">
                <span
                  className={
                    "text-[12px] " +
                    (isTodayCell
                      ? "font-semibold text-neutral-900 dark:text-neutral-100"
                      : inMonth
                        ? "font-medium text-neutral-700 dark:text-neutral-300"
                        : "font-normal text-neutral-400 dark:text-neutral-600")
                  }
                >
                  {dayOfMonth(cellDate)}
                </span>
                {closed && inMonth && (
                  <span className="text-[9px] uppercase tracking-wider text-neutral-400">
                    Closed
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1">
                {dayAppts.slice(0, MAX_CHIPS_PER_DAY).map((a) => {
                  const ds = appointmentDisplayStatus(a.status, a.ends_at);
                  const terminal = ds !== "upcoming";
                  const serviceName = a.service?.name?.trim() || null;
                  // Pretty time label: drop the leading zero so "07:30"
                  // becomes "7:30" (more compact on a tight month cell).
                  const cleanTime = a.localTime.replace(/^0/, "");
                  return (
                    <span
                      key={a.id}
                      title={
                        serviceName
                          ? `${cleanTime} · ${serviceName}`
                          : cleanTime
                      }
                      className={`truncate rounded-md border-l-[3px] px-1.5 py-0.5 text-[10px] leading-tight ${serviceCardClasses(
                        a.service?.id ?? null,
                        a.service?.name ?? null,
                      )} ${terminal ? "opacity-60" : ""}`}
                    >
                      <span className="font-medium tabular-nums">
                        {cleanTime}
                      </span>
                      {serviceName ? (
                        <span className="opacity-80"> · {serviceName}</span>
                      ) : null}
                    </span>
                  );
                })}
                {dayAppts.length > MAX_CHIPS_PER_DAY && (
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
                    +{dayAppts.length - MAX_CHIPS_PER_DAY} more
                  </span>
                )}
                {dayAppts.length === 0 && inMonth && !closed && (
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-600">
                    No appointments
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// Helper: pre-compute the month-day appointment list expected by
// MonthView from the same getAppointmentsForRange shape the week view
// already uses. Keeps the page component small and the localTime
// formatter scoped to one place.
export function groupMonthAppointmentsByDate(
  appointments: ReadonlyArray<AppointmentWithPractitionerColor>,
  tz: string,
  localTimeForLabel: (iso: string, tz: string) => string,
): Map<string, MonthDayAppt[]> {
  const byDate = new Map<string, MonthDayAppt[]>();
  for (const a of appointments) {
    if (a.status === "cancelled") continue;
    const localDate = localDateString(new Date(a.starts_at), tz);
    const arr = byDate.get(localDate) ?? [];
    arr.push({
      id: a.id,
      status: a.status,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      service: a.service,
      localTime: localTimeForLabel(a.starts_at, tz),
    });
    byDate.set(localDate, arr);
  }
  // Sort each day's chips by start time so the earliest sits at top.
  for (const list of byDate.values()) {
    list.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  }
  return byDate;
}

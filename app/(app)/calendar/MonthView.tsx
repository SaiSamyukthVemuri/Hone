import Link from "next/link";
import { localDateString, startOfWeek } from "@/lib/booking/tz";
import {
  dayOfMonth,
  isInMonth,
  monthGridDates,
  monthYearLabel,
} from "@/lib/booking/month-grid";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
import { appointmentCardClasses } from "@/lib/calendar/service-colors";
import { appointmentDisplayStatus } from "./appointment-display-status";
import { displayBlockoutLabel } from "./calendar-format";
import type { MonthDayBlocked } from "./month-blocked";

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
  blockedByDate,
  today,
  isClosedDate,
}: {
  monthAnchor: string;
  appointmentsByDate: Map<string, MonthDayAppt[]>;
  blockedByDate: Map<string, MonthDayBlocked>;
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
          const blocked = blockedByDate.get(cellDate) ?? null;
          // Compact blocked-time label for the cell: a full-day blockout shows
          // its reason (fallback "Blocked"); otherwise the first timed-block /
          // break label, with "+N" when several apply.
          const blockedLabel = blocked
            ? blocked.fullDay
              ? displayBlockoutLabel(blocked.fullDayReason)
              : blocked.labels.length > 0
                ? blocked.labels[0] +
                  (blocked.labels.length > 1
                    ? ` +${blocked.labels.length - 1}`
                    : "")
                : null
            : null;
          // Navigate to the tapped date, preserving the EXACT day. `?day=` is
          // the mobile day view's selected-day param (page.tsx): it loads the
          // week CONTAINING this date, so on mobile the day view opens focused on
          // the tapped date (not the week start) and on desktop the correct week
          // renders. Fixes the bug where tapping e.g. Thu the 23rd opened the
          // week start (Sun the 19th). Works across week/month boundaries; the
          // date is a studio-tz day-key so no device-tz shift occurs.
          const dayHref = `/calendar?view=week&week=${startOfWeek(cellDate)}&day=${cellDate}`;
          return (
            <Link
              key={cellDate}
              href={dayHref}
              aria-label={`Open ${cellDate}`}
              className={[
                // Border + min height to keep the grid even across
                // months that need 5 or 6 visible weeks.
                "relative flex min-h-[112px] flex-col gap-1 border-b border-l border-neutral-100 px-2 py-1.5 transition-colors first:border-l-0 dark:border-neutral-800/60",
                "hover:bg-neutral-50 dark:hover:bg-neutral-900",
                isTodayCell
                  ? "bg-sky-50/70 dark:bg-sky-950/25 border-t-2 border-t-sky-500"
                  : "",
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
                {isTodayCell ? (
                  // Today: a filled high-contrast circle so it is immediately
                  // obvious at a glance (light + dark), distinct from any other
                  // day's plain number.
                  <span
                    aria-label="Today"
                    className="inline-flex min-h-[22px] min-w-[22px] items-center justify-center rounded-full bg-sky-600 px-1 text-[12px] font-semibold tabular-nums text-white dark:bg-sky-500"
                  >
                    {dayOfMonth(cellDate)}
                  </span>
                ) : (
                  <span
                    className={
                      "text-[12px] " +
                      (inMonth
                        ? "font-medium text-neutral-700 dark:text-neutral-300"
                        : "font-normal text-neutral-400 dark:text-neutral-600")
                    }
                  >
                    {dayOfMonth(cellDate)}
                  </span>
                )}
                {closed && inMonth && (
                  <span className="text-[9px] uppercase tracking-wider text-neutral-400">
                    Closed
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1">
                {blockedLabel && inMonth && (
                  <span
                    title={blockedLabel}
                    className="truncate rounded-md border border-[#C9C4B6] bg-[#F4F1EA] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#3F3F3F] dark:border-stone-700 dark:bg-stone-800/80 dark:text-stone-200"
                  >
                    {blockedLabel}
                  </span>
                )}
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
                      className={`truncate rounded-md border-l-[3px] px-1.5 py-0.5 text-[10px] leading-tight ${appointmentCardClasses(
                        a.service,
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
                {dayAppts.length === 0 && inMonth && !closed && !blockedLabel && (
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

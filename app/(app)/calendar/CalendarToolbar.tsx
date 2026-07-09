import Link from "next/link";
import { CalendarViewToggle } from "./ViewToggle";

// Google/Apple-style desktop calendar toolbar (PR A). Presentational only — it
// renders navigation LINKS using the calendar's existing query params
// (?view=/?week=/?month=); it changes no booking, view-resolution, or data
// logic. Shared by the week and month renders so switching views keeps one
// coherent toolbar. The step nav (Today / ‹ / ›) is hidden on mobile for the
// WEEK view, where the PR #380 mobile day view owns day navigation; the month
// view keeps it on all sizes (mobile month has no separate nav).

type Props = {
  view: "week" | "month";
  rangeLabel: string;
  timezone: string;
  weekHref: string;
  monthHref: string;
  prevHref: string;
  todayHref: string;
  nextHref: string;
  upcomingHref: string;
  hideStepNavOnMobile: boolean;
};

const STEP_LINK =
  "flex h-9 w-9 items-center justify-center text-lg leading-none hover:bg-neutral-50 dark:hover:bg-neutral-900";

export function CalendarToolbar({
  view,
  rangeLabel,
  timezone,
  weekHref,
  monthHref,
  prevHref,
  todayHref,
  nextHref,
  upcomingHref,
  hideStepNavOnMobile,
}: Props) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        {/* The visible date range IS the heading, Google-style. */}
        <h1 className="text-2xl font-semibold tracking-tight">{rangeLabel}</h1>
        <p className="mt-0.5 text-xs text-neutral-500">{timezone}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CalendarViewToggle
          currentView={view}
          weekHref={weekHref}
          monthHref={monthHref}
        />

        {/* Today + prev/next grouped, like a calendar app. */}
        <div
          className={`items-center gap-2 ${hideStepNavOnMobile ? "hidden md:flex" : "flex"}`}
        >
          <Link
            href={todayHref}
            className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Today
          </Link>
          <div className="flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700">
            <Link href={prevHref} aria-label="Previous" className={STEP_LINK}>
              ‹
            </Link>
            <Link
              href={nextHref}
              aria-label="Next"
              className={`border-l border-neutral-300 dark:border-neutral-700 ${STEP_LINK}`}
            >
              ›
            </Link>
          </div>
        </div>

        <Link
          href={upcomingHref}
          className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Upcoming
        </Link>
      </div>
    </header>
  );
}

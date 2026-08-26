import { PendingLink } from "@/components/pending-link";
import { CalendarViewToggle } from "./ViewToggle";

// Google/Apple-style desktop calendar toolbar (PR A). Presentational only: it
// renders navigation LINKS using the calendar's existing query params
// (?view=/?week=/?month=); it changes no booking, view-resolution, or data
// logic. Shared by the week and month renders so switching views keeps one
// coherent toolbar. The step nav (Today / ‹ / ›) is hidden on mobile for the
// WEEK view, where the PR #380 mobile day view owns day navigation; the month
// view keeps it on all sizes (mobile month has no separate nav).
//
// UI-01C: every control here is a PendingLink, not a Link. Five of the six
// change only the QUERY (?view=/?week=/?month=) on a pathname the practitioner
// is already on, so the segment never changes, React reuses the tree, and a
// route-level loading boundary structurally cannot render for them — the whole
// toolbar sits there, complete and stale, while the server re-reads the week.
// The sixth (Upcoming) is a segment change, and with zero loading.tsx in the
// tree the old page stays mounted for that too. In both cases the only thing
// that can speak is the control under the finger, which is exactly what the
// shipped primitive does. It starts no navigation and changes no destination:
// every href below is the one that was already there.

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
          <PendingLink
            href={todayHref}
            data-testid="calendar-today"
            /* The REQUEST, never the outcome, and never a claim about WHICH
               dates are arriving — this control's destination differs between
               the week and month views. */
            pendingLabel="Loading calendar…"
            className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Today
          </PendingLink>
          <div className="flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700">
            <PendingLink
              href={prevHref}
              aria-label="Previous"
              data-testid="calendar-prev"
              pendingLabel="Loading calendar…"
              className={STEP_LINK}
            >
              ‹
            </PendingLink>
            <PendingLink
              href={nextHref}
              aria-label="Next"
              data-testid="calendar-next"
              pendingLabel="Loading calendar…"
              className={`border-l border-neutral-300 dark:border-neutral-700 ${STEP_LINK}`}
            >
              ›
            </PendingLink>
          </div>
        </div>

        <PendingLink
          href={upcomingHref}
          data-testid="calendar-upcoming"
          pendingLabel="Opening upcoming…"
          className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Upcoming
        </PendingLink>
      </div>
    </header>
  );
}

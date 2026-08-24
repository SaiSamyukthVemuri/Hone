import { PendingLink } from "@/components/pending-link";

// Week | Month segmented control for the calendar header. Plain
// server component so the active state survives a full page
// navigation (each tab is just a different ?view= URL). Active link
// is heavier; inactive link is muted; both share the same touch
// target so a phone tap lands cleanly. Mirrors the same shape used
// by /clients ViewTabs to keep the visual language consistent.
//
// Each toggle preserves the calendar's existing anchor params so
// navigating across views does not reset orientation:
//   * Week tab carries the same `?week=` the page was already on,
//     defaulting to the current week when none was set.
//   * Month tab carries `?view=month` plus the same `?month=`
//     anchor (defaulting to the current month).
//
// Defaults are computed by the caller (page.tsx) since "today" is
// timezone-sensitive and that's the server's responsibility.
//
// UI-01C: PendingLink, not Link — the same primitive the rest of the
// toolbar uses, for the same reason. Switching view changes only
// `?view=`, so no route boundary can render and the tab under the
// finger is the only thing on screen able to say the request left.
// The mark is absolutely positioned and the label only fades, so the
// segmented control does not resize mid-tap, which is the promise
// its two equal-width tabs are making.
export function CalendarViewToggle({
  currentView,
  weekHref,
  monthHref,
}: {
  currentView: "week" | "month";
  weekHref: string;
  monthHref: string;
}) {
  const tabs: ReadonlyArray<{
    value: "week" | "month";
    label: string;
    href: string;
  }> = [
    { value: "week", label: "Week", href: weekHref },
    { value: "month", label: "Month", href: monthHref },
  ];
  return (
    <nav
      aria-label="Calendar view"
      className="flex w-fit gap-1 rounded-md border border-neutral-200 bg-neutral-50 p-1 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      {tabs.map((tab) => {
        const active = tab.value === currentView;
        return (
          <PendingLink
            key={tab.value}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            data-testid={`calendar-view-${tab.value}`}
            pendingLabel="Loading view…"
            className={
              active
                ? "rounded-[5px] bg-white px-3 py-1 font-medium text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-100"
                : "rounded-[5px] px-3 py-1 text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }
          >
            {tab.label}
          </PendingLink>
        );
      })}
    </nav>
  );
}

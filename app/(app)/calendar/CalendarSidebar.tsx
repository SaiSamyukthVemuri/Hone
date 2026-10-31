"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarMiniMonth } from "./CalendarMiniMonth";
import { INSIGHTS_RULE, type TimeInsightsModel } from "@/lib/calendar/time-insights";
import {
  SELECTION_PARAM,
  SIDEBAR_STORAGE_KEY,
  readStoredSelection,
  restoreParam,
  serializeSelection,
  writeStoredSelection,
} from "@/lib/calendar/practitioner-selection";

// HON-48: the calendar's left sidebar (Google Calendar's shape): a mini month and the list of
// practitioners the viewer may see, each with a checkbox and their configured colour.
//
// VIEW-ONLY. A checkbox writes the `people` URL param (and a per-viewer local preference) and the
// server page redraws the same rows it already loaded, narrowed. Nothing here calls an action, an
// RPC or a booking path, and the practitioner list is whatever the page passes in (the page's own
// studio-scoped read); this component cannot add anyone to it.
//
// Collapsing hands the space back to the schedule. Below md the sidebar is a drawer.

export type SidebarPractitioner = {
  id: string;
  name: string;
  swatchClass: string;
  colorLabel: string;
};

const DESKTOP_QUERY = "(min-width: 768px)";

export function CalendarSidebar({
  studioId,
  view,
  anchorDate,
  selectedDate,
  today,
  practitioners,
  selectedIds,
  selectionParam,
  insights,
  children,
}: {
  studioId: string;
  view: "day" | "week" | "month";
  anchorDate: string;
  /** The date the view is on (null for Month, which has no single date). */
  selectedDate: string | null;
  today: string;
  practitioners: ReadonlyArray<SidebarPractitioner>;
  /** What the server drew: every listed id when it is everyone. */
  selectedIds: ReadonlyArray<string>;
  /** The server's selection as a param (undefined = everyone). */
  selectionParam: string | undefined;
  /** Booked hours and count for the displayed period and selection (lib/calendar/time-insights.ts). */
  insights: TimeInsightsModel;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(true); // desktop: sidebar column shown
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile: drawer shown
  const [isDesktop, setIsDesktop] = useState(true);
  // What the boxes show right now: follows the server, but moves at once on a click.
  const serverKey = selectedIds.join(",");
  const [checked, setChecked] = useState<ReadonlyArray<string>>(selectedIds);
  useEffect(() => setChecked(selectedIds), [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const listedIds = practitioners.map((p) => p.id);
  const hasParam = search.has(SELECTION_PARAM);
  const restored = useRef(false);

  // The collapsed state is a per-viewer preference.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "closed") setOpen(false);
    } catch {
      /* default open */
    }
  }, []);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const apply = () => setIsDesktop(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const replaceWith = useCallback(
    (param: string | undefined) => {
      const next = new URLSearchParams(search.toString());
      if (param === undefined) next.delete(SELECTION_PARAM);
      else next.set(SELECTION_PARAM, param);
      const qs = next.toString();
      startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [pathname, router, search],
  );

  // A link with no `people` param restores the viewer's own last selection (once); a link with one
  // is the selection, and is remembered.
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    if (hasParam) {
      writeStoredSelection(storage, studioId, selectionParam);
      return;
    }
    if (restored.current) return;
    restored.current = true;
    const param = restoreParam(readStoredSelection(storage, studioId));
    if (param !== null) replaceWith(param);
  }, [hasParam, selectionParam, studioId, replaceWith]);

  function toggle(id: string) {
    const next = checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id];
    setChecked(next);
    const param = serializeSelection(next, listedIds);
    try {
      writeStoredSelection(window.localStorage, studioId, param);
    } catch {
      /* the URL carries it */
    }
    replaceWith(param);
  }

  function toggleSidebar() {
    if (isDesktop) {
      const next = !open;
      setOpen(next);
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "open" : "closed");
      } catch {
        /* not remembered */
      }
    } else {
      setDrawerOpen((v) => !v);
    }
  }

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const expanded = isDesktop ? open : drawerOpen;
  const asideClass = [
    "shrink-0",
    drawerOpen
      ? "fixed inset-y-0 left-0 z-50 block w-72 overflow-y-auto border-r border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
      : "hidden",
    open
      ? "md:static md:z-auto md:block md:w-60 md:overflow-visible md:border-0 md:bg-transparent md:p-0 md:shadow-none dark:md:bg-transparent"
      : "md:hidden",
  ].join(" ");

  return (
    <div className="flex items-start gap-4">
      {drawerOpen && (
        <button
          type="button"
          aria-label="Close calendars"
          data-testid="calendar-sidebar-backdrop"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
        />
      )}
      <aside
        id="calendar-sidebar"
        data-testid="calendar-sidebar"
        data-open={expanded ? "true" : "false"}
        aria-label="Calendars"
        role={drawerOpen && !isDesktop ? "dialog" : undefined}
        aria-modal={drawerOpen && !isDesktop ? true : undefined}
        className={asideClass}
      >
        <div className="flex flex-col gap-5 md:sticky md:top-4">
          <CalendarMiniMonth
            anchorDate={anchorDate}
            selectedDate={selectedDate}
            today={today}
            view={view}
            selectionParam={selectionParam}
          />
          <details open data-testid="calendar-time-insights" className="group rounded-md border border-neutral-200 dark:border-neutral-800">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Time insights
            </summary>
            <div className="flex flex-col gap-1 px-3 pb-3" title={INSIGHTS_RULE}>
              <p data-testid="time-insights-label" className="text-xs text-neutral-600 dark:text-neutral-400">
                {insights.label}
              </p>
              <p
                data-testid="time-insights-total"
                data-minutes={insights.minutes}
                data-count={insights.count}
                aria-describedby="time-insights-rule"
                className="text-base font-semibold tabular-nums"
              >
                {insights.summary}
              </p>
              <p id="time-insights-rule" className="text-[11px] leading-snug text-neutral-500">
                Booked time. Cancelled excluded; blocks and breaks never counted.
              </p>
              <span className="sr-only">{INSIGHTS_RULE}</span>
            </div>
          </details>
          <section aria-label="Practitioners" data-testid="calendar-sidebar-practitioners">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Practitioners</h2>
            <ul className="flex flex-col gap-1">
              {practitioners.map((p) => (
                <li key={p.id} data-testid="calendar-sidebar-practitioner" data-practitioner-id={p.id}>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900">
                    <input
                      type="checkbox"
                      data-testid="calendar-sidebar-checkbox"
                      data-practitioner-id={p.id}
                      checked={checked.includes(p.id)}
                      onChange={() => toggle(p.id)}
                      className="h-4 w-4 shrink-0"
                    />
                    <span aria-hidden="true" data-color={p.colorLabel} className={`h-3 w-3 shrink-0 rounded-sm ${p.swatchClass}`} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <button
            type="button"
            data-testid="calendar-sidebar-toggle"
            aria-expanded={expanded}
            aria-controls="calendar-sidebar"
            onClick={toggleSidebar}
            className="inline-flex items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            <span aria-hidden="true">☰</span>
            {expanded ? "Hide calendars" : "Calendars"}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

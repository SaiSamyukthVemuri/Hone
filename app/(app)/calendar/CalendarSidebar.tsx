"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { type TimeFormat } from "@/lib/booking/tz";
import type { CalendarRebookSource } from "@/lib/calendar/rebook-source";
import { CalendarFindTime, type FindTimeService, type CalendarOpening } from "./CalendarFindTime";
import { OpeningContext } from "./CalendarOpeningPreview";
import { CalendarMiniMonth } from "./CalendarMiniMonth";
import { INSIGHTS_RULE, type TimeInsightsModel } from "@/lib/calendar/time-insights";
import {
  SELECTION_PARAM,
  SIDEBAR_STORAGE_KEY,
  clearLegacySelection,
  readStoredSelection,
  decideFirstVisit,
  serializeSelection,
  writeStoredSelection,
} from "@/lib/calendar/practitioner-selection";

// Browse controls the calendar's display filter. Find time independently searches the
// services and practitioners the signed-in viewer may book. Picking a result previews it.
export type SidebarPractitioner = {
  id: string;
  name: string;
  swatchClass: string;
  colorLabel: string;
};

const DESKTOP_QUERY = "(min-width: 768px)";

export function CalendarSidebar({
  studioId,
  viewerId,
  view,
  anchorDate,
  selectedDate,
  today,
  practitioners,
  selectedIds,
  selectionParam,
  ownFirstId,
  insights,
  findTime,
  children,
}: {
  studioId: string;
  /** The viewer's practitioner id: the stored selection is per studio AND per viewer (shared browsers). */
  viewerId: string;
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
  /** The viewer's own practitioner id when a first visit should open on their column; null/absent = everyone. */
  ownFirstId?: string | null;
  /** Booked hours and count for the displayed period and selection (lib/calendar/time-insights.ts). */
  insights: TimeInsightsModel;
  findTime: {
    services: ReadonlyArray<FindTimeService>;
    isOwner: boolean;
    hasDayView: boolean;
    timeFormat: TimeFormat;
    rebookId?: string;
    clientName?: string;
    rebook?: CalendarRebookSource | null;
  };
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(true); // desktop: sidebar column shown
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile: drawer shown
  const [isDesktop, setIsDesktop] = useState(true);
  const startInFinder = Boolean(findTime.rebookId) || search.get("find") === "1";
  const [mode, setMode] = useState<"browse" | "find">(startInFinder ? "find" : "browse");
  const [opening, setOpening] = useState<CalendarOpening | null>(null);
  const [booking, setBooking] = useState(false);
  const [searchVersion, setSearchVersion] = useState(0);
  const asideRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const drawerWasOpen = useRef(false);
  // What the boxes show right now: follows the server, but moves at once on a click.
  const serverKey = selectedIds.join(",");
  const [checked, setChecked] = useState<ReadonlyArray<string>>(selectedIds);
  useEffect(() => setChecked(selectedIds), [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const listedIds = practitioners.map((p) => p.id);
  const listedIdsRef = useRef(listedIds); // read by the one-time restore below without re-running it every render
  listedIdsRef.current = listedIds;
  const hasParam = search.has(SELECTION_PARAM);
  const restored = useRef(false);

  // The collapsed state is a per-viewer preference.
  useEffect(() => {
    try {
      if (!startInFinder && window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "closed") setOpen(false);
    } catch {
      /* default open */
    }
  }, [startInFinder]);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const apply = () => setIsDesktop(mq.matches);
    apply();
    if (startInFinder && !mq.matches) setDrawerOpen(true);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [startInFinder]);

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
    // Once per mount, drop the pre-fix per-studio key without reading it (it belonged to an unknown person).
    if (!restored.current) clearLegacySelection(storage, studioId);
    if (hasParam) writeStoredSelection(storage, studioId, viewerId, selectionParam);
    // An explicit `?people=` is a choice: from here the own-first default never re-applies in this mount,
    // even when storage is blocked and nothing was remembered (decideFirstVisit).
    const { decided, param } = decideFirstVisit({
      decided: restored.current,
      hasParam,
      readStored: () => readStoredSelection(storage, studioId, viewerId),
      ownFirstId,
      listedIds: listedIdsRef.current,
    });
    restored.current = decided;
    if (param !== null) replaceWith(param);
  }, [hasParam, selectionParam, studioId, viewerId, replaceWith, ownFirstId]);

  function toggle(id: string) {
    const next = checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id];
    setChecked(next);
    const param = serializeSelection(next, listedIds);
    restored.current = true; // the viewer chose: the first-visit default is done for this mount
    try {
      writeStoredSelection(window.localStorage, studioId, viewerId, param);
    } catch {
      /* the URL carries it */
    }
    replaceWith(param);
  }

  function clearOpening() {
    setOpening(null);
    setBooking(false);
  }

  function leaveRebook(find: boolean) {
    if (!findTime.rebookId && !search.has("find")) return;
    const params = new URLSearchParams(search.toString());
    params.delete("rebook");
    if (find) params.set("find", "1");
    else params.delete("find");
    startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
  }

  function findTimeMode() {
    setMode("find");
    if (isDesktop) setOpen(true);
    else setDrawerOpen(true);
  }

  function selectOpening(result: CalendarOpening) {
    setOpening(result);
    setBooking(false);
    setDrawerOpen(false);
    const next = new URLSearchParams({ view: findTime.hasDayView ? "day" : "week", day: result.date });
    // Preserve visible colleagues. If this search found someone outside the display filter,
    // include their column so the result can be previewed in context.
    const people = serializeSelection([...checked, result.practitionerId], listedIds);
    if (people !== undefined) next.set(SELECTION_PARAM, people);
    if (findTime.rebookId) next.set("rebook", findTime.rebookId);
    startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
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

  // The drawer is a modal dialog on narrow screens: focus moves into it on open and back to the
  // toggle on close.
  useEffect(() => {
    if (drawerOpen) asideRef.current?.focus();
    else if (drawerWasOpen.current) toggleRef.current?.focus();
    drawerWasOpen.current = drawerOpen;
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
    <OpeningContext.Provider value={{
      opening: findTime.rebookId && !findTime.rebook ? null : opening,
      booking,
      openBooking: () => setBooking(true),
      dismiss: clearOpening,
      booked: () => {
        clearOpening();
        setSearchVersion((n) => n + 1);
        leaveRebook(true);
      },
    }}>
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
        ref={asideRef}
        tabIndex={drawerOpen && !isDesktop ? -1 : undefined}
        data-testid="calendar-sidebar"
        data-open={expanded ? "true" : "false"}
        aria-label="Calendars"
        role={drawerOpen && !isDesktop ? "dialog" : undefined}
        aria-modal={drawerOpen && !isDesktop ? true : undefined}
        className={asideClass}
      >
        <div className="flex flex-col gap-4 md:sticky md:top-4 md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto md:px-1">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1" role="group" aria-label="Calendar sidebar mode">
            <Button size="sm" variant={mode === "browse" ? "secondary" : "quiet"} aria-pressed={mode === "browse"}
              onClick={() => { setMode("browse"); clearOpening(); leaveRebook(false); }}>Browse</Button>
            <Button size="sm" variant={mode === "find" ? "secondary" : "quiet"} aria-pressed={mode === "find"}
              onClick={findTimeMode}>Find time</Button>
          </div>
          {mode === "find" ? (
            findTime.rebookId && !findTime.rebook
              ? <p role="status" className="text-sm">This previous appointment is unavailable. Open the calendar to start a new booking.</p>
              : <>{findTime.clientName && <p className="text-sm font-medium">Rebook for {findTime.clientName}</p>}
                <CalendarFindTime key={searchVersion} {...findTime} practitioners={practitioners} viewerId={viewerId} today={today}
                  anchorDate={anchorDate} selected={opening} onSelect={selectOpening} onClear={clearOpening} /></>
          ) : <>
          <CalendarMiniMonth
            anchorDate={anchorDate}
            selectedDate={selectedDate}
            today={today}
            view={view}
            selectionParam={selectionParam}
          />
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
          </>}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            data-testid="calendar-sidebar-toggle"
            ref={toggleRef}
            aria-expanded={expanded}
            aria-controls="calendar-sidebar"
            onClick={toggleSidebar}
            className="inline-flex items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            <span aria-hidden="true">☰</span>
            {expanded ? "Hide calendars" : "Calendars"}
          </button>
          <Button size="sm" onClick={() => { clearOpening(); leaveRebook(true); findTimeMode(); }}>+ Appointment</Button>
        </div>
        {children}
      </div>
    </div>
    </OpeningContext.Provider>
  );
}

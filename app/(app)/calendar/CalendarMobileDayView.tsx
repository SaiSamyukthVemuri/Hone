"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Service, StudioTimedBlock } from "@/lib/types/database";
import type {
  AppointmentWithPractitionerColor,
  RecurringBreakOccurrenceWithRule,
} from "@/lib/booking/queries";
import { addDays, minutesToHHMM, type TimeFormat } from "@/lib/booking/tz";
import { HOUR_END, HOUR_START } from "./calendar-constants";
import { QuickBookDrawer, type QuickBookClient } from "./QuickBookDrawer";
import { TimedBlockEditDrawer } from "./TimedBlockEditDrawer";
import { MobileDayTimeline } from "./MobileDayTimeline";
import type { DayAvailability } from "./DayColumn";

// Per-day slice of the week's data the calendar page already loaded. Passed as
// plain JSON to this client component — NO new/divergent query is introduced.
export type MobileDayData = {
  date: string;
  weekdayShort: string;
  monthDayLabel: string;
  appts: AppointmentWithPractitionerColor[];
  timedBlocks: StudioTimedBlock[];
  recurringBreaks: RecurringBreakOccurrenceWithRule[];
  availability: DayAvailability | null;
  closedDay: boolean;
  blocked: boolean;
  blockedReason: string | null;
  isToday: boolean;
};

type Props = {
  days: MobileDayData[];
  initialDate: string;
  today: string;
  tz: string;
  timeFormat: TimeFormat;
  isOwner: boolean;
  clients: QuickBookClient[];
  services: Service[];
  returnTo: string;
};

// Current minute-of-day in the studio timezone (same technique as NowLine).
function minuteOfDayInTz(tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export function CalendarMobileDayView({
  days,
  initialDate,
  today,
  tz,
  timeFormat,
  isOwner,
  clients,
  services,
  returnTo,
}: Props) {
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [draft, setDraft] = useState<{
    localDate: string;
    localTime: string;
  } | null>(null);
  const [editingBlock, setEditingBlock] = useState<StudioTimedBlock | null>(
    null,
  );

  const idx = Math.max(
    0,
    days.findIndex((d) => d.date === selectedDate),
  );
  const day = days[idx];
  if (!day) return null;

  function goPrev() {
    if (idx > 0) setSelectedDate(days[idx - 1].date);
    else router.push(`/calendar?day=${addDays(days[0].date, -1)}`);
  }
  function goNext() {
    if (idx < days.length - 1) setSelectedDate(days[idx + 1].date);
    else router.push(`/calendar?day=${addDays(days[days.length - 1].date, 1)}`);
  }
  function goToday() {
    const ti = days.findIndex((d) => d.date === today);
    if (ti >= 0) setSelectedDate(today);
    else router.push("/calendar");
  }

  // Floating "+" default: on today within working hours, the next rounded
  // 30-min mark; otherwise the first visible working time (HOUR_START). Never
  // Willow-specific — derived purely from the visible-hours constants.
  function bookFromPlus() {
    let minutes = HOUR_START * 60;
    if (day.date === today) {
      const now = minuteOfDayInTz(tz);
      const rounded = Math.ceil(now / 30) * 30;
      if (rounded >= HOUR_START * 60 && rounded < HOUR_END * 60) {
        minutes = rounded;
      }
    }
    setDraft({ localDate: day.date, localTime: minutesToHHMM(minutes) });
  }

  return (
    <div className="md:hidden">
      {/* Sticky mobile header: date + Today + prev/next + week strip. Kept
          within the app's page padding (no negative margin) so it never causes
          horizontal page overflow. */}
      <div className="sticky top-14 z-20 border-b border-neutral-200 bg-white/95 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
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
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Today
            </button>
            <button
              type="button"
              aria-label="Previous day"
              onClick={goPrev}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 text-lg hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Next day"
              onClick={goNext}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 text-lg hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              ›
            </button>
          </div>
        </div>

        {/* Compact week strip — NAVIGATION ONLY (pills), never an interactive
            grid. Tap a day to switch within the loaded week (no fetch). */}
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
                  "flex flex-1 flex-col items-center rounded-md py-1 text-[11px] leading-tight transition " +
                  (selected
                    ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                    : d.isToday
                      ? "bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100"
                      : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900")
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

        {day.blocked && (
          <div className="mt-2 rounded-md bg-neutral-200/80 px-2 py-1 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-200">
            Blocked{day.blockedReason ? `: ${day.blockedReason}` : ""}
          </div>
        )}
      </div>

      {/* Single vertical scroll for the one selected day. No horizontal scroll:
          the timeline is full-width and days change via buttons/strip only. */}
      <div className="mt-2 max-h-[calc(100dvh-16rem)] overflow-y-auto overscroll-contain rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
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
          returnTo={returnTo}
          onBookAt={(localTime) =>
            setDraft({ localDate: day.date, localTime })
          }
          onEditBlock={(block) => setEditingBlock(block)}
        />
      </div>

      {/* Floating "+" (kept per Chloe). Context-aware default time. */}
      <button
        type="button"
        aria-label="Add appointment"
        onClick={bookFromPlus}
        className="fixed bottom-6 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-neutral-900 text-3xl font-light text-white shadow-lg active:scale-95 dark:bg-white dark:text-neutral-900"
      >
        +
      </button>

      {/* Reused drawers — identical props/behaviour to the desktop DayColumn. */}
      <QuickBookDrawer
        open={draft !== null}
        draft={draft}
        clients={clients}
        services={services}
        studioTimezone={tz}
        timeFormat={timeFormat}
        onClose={() => setDraft(null)}
      />
      <TimedBlockEditDrawer
        block={editingBlock}
        isOwner={isOwner}
        studioTimezone={tz}
        timeFormat={timeFormat}
        onClose={() => setEditingBlock(null)}
      />
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Service, StudioTimedBlock } from "@/lib/types/database";
import type {
  AppointmentWithPractitionerColor,
  RecurringBreakOccurrenceWithRule,
} from "@/lib/booking/queries";
import { addDays, minutesToHHMM, type TimeFormat } from "@/lib/booking/tz";
import { HOUR_END, HOUR_START } from "./calendar-constants";
import { QuickBookDrawer, type QuickBookClient } from "./QuickBookDrawer";
import { QuickBlockDrawer, type QuickBlockDraft } from "./QuickBlockDrawer";
import { DragActionChooser, type DragRangeDraft } from "./DragActionChooser";
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
  // Part 4 Item 6: forwarded to QuickBookDrawer's owner practitioner selector.
  practitionerCapacityEnabled: boolean;
  currentPractitionerId: string;
  currentPractitionerName: string;
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
  practitionerCapacityEnabled,
  currentPractitionerId,
  currentPractitionerName,
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
  // "+" opens a chooser (Book appointment / Block time); the chosen action then
  // opens the existing QuickBook / QuickBlock drawers — same model as desktop
  // DayColumn (no mobile-only model). Block-time create mirrors the desktop
  // calendar block-create authorization (available to active practitioners);
  // edit/delete stays owner-gated via TimedBlockEditDrawer below.
  const [chooserDraft, setChooserDraft] = useState<DragRangeDraft | null>(null);
  const [blockDraft, setBlockDraft] = useState<QuickBlockDraft | null>(null);
  // Keep the selected day pill scrolled into view within the horizontally
  // scrollable date strip (narrow screens).
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(
      '[data-selected="true"]',
    );
    el?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [selectedDate]);

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

  // Floating "+" default time: on today within working hours, the next rounded
  // 30-min mark; otherwise the first visible working time (HOUR_START). Never
  // Willow-specific — derived purely from the visible-hours constants. Opens the
  // Book/Block chooser prefilled with a 60-min default range for the selected day.
  function openPlusChooser() {
    let minutes = HOUR_START * 60;
    if (day.date === today) {
      const now = minuteOfDayInTz(tz);
      const rounded = Math.ceil(now / 30) * 30;
      if (rounded >= HOUR_START * 60 && rounded < HOUR_END * 60) {
        minutes = rounded;
      }
    }
    const end = Math.min(minutes + 60, HOUR_END * 60);
    setChooserDraft({
      localDate: day.date,
      startLocal: minutesToHHMM(minutes),
      endLocal: minutesToHHMM(end > minutes ? end : minutes + 30),
    });
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

        {/* Weekday/date strip — tap a day to switch within the loaded week (no
            fetch). Horizontally scrollable on narrow screens (min-width per pill;
            flex-1 fills on wider ones) — the container scrolls, never the page.
            The selected pill is scrolled into view (see effect above). Today keeps
            a high-contrast ring so it stays identifiable even when selected. */}
        <div ref={stripRef} className="mt-2 flex gap-1 overflow-x-auto pb-1">
          {days.map((d) => {
            const selected = d.date === selectedDate;
            const dateNum = d.monthDayLabel.replace(/^[A-Za-z]+\s/, "");
            const hasAppts = d.appts.length > 0;
            return (
              <button
                key={d.date}
                type="button"
                data-selected={selected}
                onClick={() => setSelectedDate(d.date)}
                aria-pressed={selected}
                aria-label={`${d.isToday ? "Today, " : ""}${d.weekdayShort} ${dateNum}${selected ? ", selected" : ""}`}
                className={
                  "flex min-h-[44px] min-w-[2.75rem] flex-1 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md py-1 text-[11px] leading-tight transition " +
                  (selected
                    ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                    : d.isToday
                      ? "bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100"
                      : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900") +
                  (d.isToday
                    ? " ring-2 ring-inset ring-sky-500 dark:ring-sky-400"
                    : "")
                }
              >
                <span className="font-medium uppercase">{d.weekdayShort}</span>
                <span className="tabular-nums">{dateNum}</span>
                {/* Appointment indicator dot — visible with contrast in both the
                    selected (black) and normal pill states. */}
                <span
                  aria-hidden
                  className={
                    "h-1 w-1 rounded-full " +
                    (hasAppts
                      ? selected
                        ? "bg-white dark:bg-neutral-900"
                        : "bg-sky-500"
                      : "bg-transparent")
                  }
                />
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

      {/* Floating "+" (kept per Chloe). Opens the Book/Block chooser. */}
      <button
        type="button"
        aria-label="Add appointment or block time"
        onClick={openPlusChooser}
        className="fixed bottom-6 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-neutral-900 text-3xl font-light text-white shadow-lg active:scale-95 dark:bg-white dark:text-neutral-900"
      >
        +
      </button>

      {/* "+" chooser — reuses the desktop drag-action chooser (Book / Block). */}
      <DragActionChooser
        open={chooserDraft !== null}
        draft={chooserDraft}
        timeFormat={timeFormat}
        onCancel={() => setChooserDraft(null)}
        onBook={() => {
          if (chooserDraft) {
            setDraft({
              localDate: chooserDraft.localDate,
              localTime: chooserDraft.startLocal,
            });
          }
          setChooserDraft(null);
        }}
        onBlock={() => {
          if (chooserDraft) {
            setBlockDraft({
              localDate: chooserDraft.localDate,
              startLocal: chooserDraft.startLocal,
              endLocal: chooserDraft.endLocal,
            });
          }
          setChooserDraft(null);
        }}
      />

      {/* Reused drawers — identical props/behaviour to the desktop DayColumn. */}
      <QuickBookDrawer
        open={draft !== null}
        draft={draft}
        clients={clients}
        services={services}
        studioTimezone={tz}
        timeFormat={timeFormat}
        practitionerCapacityEnabled={practitionerCapacityEnabled}
        isOwner={isOwner}
        currentPractitionerId={currentPractitionerId}
        currentPractitionerName={currentPractitionerName}
        onClose={() => setDraft(null)}
      />
      {/* Block-time create — the same block-create drawer the desktop DayColumn
          uses (available to active practitioners). */}
      <QuickBlockDrawer
        open={blockDraft !== null}
        draft={blockDraft}
        studioTimezone={tz}
        onClose={() => setBlockDraft(null)}
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

"use client";

import Link from "next/link";
import { useRef } from "react";
import type { StudioTimedBlock } from "@/lib/types/database";
import type {
  AppointmentWithPractitionerColor,
  RecurringBreakOccurrenceWithRule,
} from "@/lib/booking/queries";
import {
  localTimeString,
  formatTimeForStudio,
  minutesToHHMM,
  type TimeFormat,
} from "@/lib/booking/tz";
import { serviceCardClasses } from "@/lib/calendar/service-colors";
import { appointmentDisplayStatus } from "./appointment-display-status";
import {
  GRID_HEIGHT,
  HOUR_END,
  HOUR_START,
  ROW_HEIGHT_PX,
  ROW_MINUTES,
  VISIBLE_MINUTES,
} from "./calendar-constants";
import {
  TIMED_BLOCK_LABEL,
  displayRecurringBreakLabel,
  formatHourLabel,
  timeRangeLabel,
} from "./calendar-format";
import { NowLine } from "./NowLine";
import type { DayAvailability } from "./DayColumn";

// Single-day mobile timeline (PR: mobile calendar redesign). Renders ONE
// selected day as a vertical 1px=1min timeline — the same positioning model as
// the desktop DayColumn, but full-width with a single vertical scroll (no
// horizontal week-grid panning). Reuses the exact grid constants, card markup,
// service colors, NowLine, and studio-tz/12h-24h formatting. It renders + reads
// data only; every create/edit action is delegated to the parent
// (CalendarMobileDayView) via callbacks, which opens the existing drawers. No
// booking/block server logic lives here.

// 15-minute tap snapping, matching the desktop CLICK_SNAP behaviour.
const CLICK_SNAP_MINUTES = 15;

function hhmmToMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

type Props = {
  date: string;
  appts: AppointmentWithPractitionerColor[];
  timedBlocks: StudioTimedBlock[];
  recurringBreaks: RecurringBreakOccurrenceWithRule[];
  availability: DayAvailability | null;
  closedDay: boolean;
  isToday: boolean;
  tz: string;
  timeFormat: TimeFormat;
  returnTo: string;
  // Open the quick-book drawer at an exact 24h HH:MM on this day.
  onBookAt: (localTime: string) => void;
  // Open the timed-block edit drawer for a tapped block.
  onEditBlock: (block: StudioTimedBlock) => void;
};

export function MobileDayTimeline({
  date,
  appts,
  timedBlocks,
  recurringBreaks,
  availability,
  closedDay,
  isToday,
  tz,
  timeFormat,
  returnTo,
  onBookAt,
  onEditBlock,
}: Props) {
  const dayRef = useRef<HTMLDivElement>(null);

  // Out-of-hours tint (gray guidance only), identical model to DayColumn:
  // closed day tints the whole grid; open day tints before-open + after-close.
  const gridTopMinutes = HOUR_START * 60;
  const tintRegions: Array<{ top: number; height: number }> = [];
  if (availability) {
    if (!availability.isOpen) {
      tintRegions.push({ top: 0, height: GRID_HEIGHT });
    } else {
      const open = hhmmToMinutes(availability.openTime);
      const close = hhmmToMinutes(availability.closeTime);
      if (open != null && open > gridTopMinutes) {
        const h = Math.min(GRID_HEIGHT, open - gridTopMinutes);
        if (h > 0) tintRegions.push({ top: 0, height: h });
      }
      if (close != null && close < HOUR_END * 60) {
        const topPx = Math.max(0, close - gridTopMinutes);
        const h = GRID_HEIGHT - topPx;
        if (h > 0) tintRegions.push({ top: topPx, height: h });
      }
    }
  }

  // Tap an empty part of the timeline → book at that snapped 24h time.
  function handleTapBook(clientY: number) {
    const rect = dayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const y = clientY - rect.top;
    const minutesFromTop = Math.max(0, Math.min(VISIBLE_MINUTES - 1, y));
    const total = HOUR_START * 60 + minutesFromTop;
    const snapped = Math.floor(total / CLICK_SNAP_MINUTES) * CLICK_SNAP_MINUTES;
    if (snapped < HOUR_START * 60 || snapped >= HOUR_END * 60) return;
    onBookAt(minutesToHHMM(snapped));
  }

  return (
    <div className="relative flex">
      {/* Time rail (left). Fixed-width, same 1px=1min hour offsets as the grid. */}
      <div
        className="relative w-14 shrink-0 border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
        style={{ height: GRID_HEIGHT }}
        aria-hidden
      >
        {Array.from(
          { length: HOUR_END - HOUR_START },
          (_, i) => HOUR_START + i,
        ).map((h) => (
          <div
            key={h}
            style={{ top: (h - HOUR_START) * 60, height: 60 }}
            className="absolute inset-x-0 px-1.5 pt-0.5 text-right text-[10px] font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300"
          >
            {formatHourLabel(h)}
          </div>
        ))}
      </div>

      {/* Day area. Single column, full remaining width. */}
      <div
        ref={dayRef}
        className="relative flex-1"
        style={{ height: GRID_HEIGHT }}
      >
        {isToday && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0 bg-sky-200/50 dark:bg-sky-900/30"
          />
        )}
        {isToday && <NowLine tz={tz} />}

        {/* Out-of-hours / closed tint. */}
        {tintRegions.map((r, i) => (
          <div
            key={`tint-${i}`}
            aria-hidden
            style={{ top: r.top, height: r.height }}
            className="pointer-events-none absolute inset-x-0 z-0 border-y border-neutral-300/60 bg-neutral-200/70 dark:border-neutral-700/50 dark:bg-neutral-800/65"
          />
        ))}

        {/* Hour / half-hour grid lines. */}
        {Array.from({ length: VISIBLE_MINUTES / ROW_MINUTES }, (_, i) => i).map(
          (i) => (
            <div
              key={i}
              style={{ top: i * ROW_HEIGHT_PX, height: ROW_HEIGHT_PX }}
              className={
                "absolute inset-x-0 border-b " +
                (i % 2 === 1
                  ? "border-neutral-100/70 dark:border-neutral-800/30"
                  : "border-neutral-200/70 dark:border-neutral-800/60")
              }
            />
          ),
        )}

        {/* Tap-to-book layer. Sits beneath every card (z-0) so it only fires on
            empty space. touchAction:manipulation keeps native vertical scroll. */}
        <button
          type="button"
          aria-label={`Book on ${date}`}
          onClick={(e) => handleTapBook(e.clientY)}
          style={{ touchAction: "manipulation" }}
          className="absolute inset-0 z-0 cursor-pointer select-none outline-none transition-colors focus-visible:bg-sky-100/40 dark:focus-visible:bg-sky-900/20"
        />

        {/* Recurring breaks (hidden on closed days, matching DayColumn). */}
        {!closedDay &&
          recurringBreaks.map((occ) => {
            const start = new Date(occ.starts_at);
            const end = new Date(occ.ends_at);
            const [h, m] = localTimeString(start, tz).split(":").map(Number);
            const startMin = (h - HOUR_START) * 60 + m;
            if (startMin < 0 || startMin >= VISIBLE_MINUTES) return null;
            const durationMinutes = Math.max(
              5,
              Math.round((end.getTime() - start.getTime()) / 60_000),
            );
            const top = (startMin / ROW_MINUTES) * ROW_HEIGHT_PX;
            const height = Math.max(
              ROW_HEIGHT_PX - 2,
              (durationMinutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
            );
            const label = displayRecurringBreakLabel(occ.rule?.label);
            return (
              <div
                key={occ.id}
                style={{ top, height }}
                className="absolute inset-x-1 z-10 overflow-hidden rounded-md border border-dashed border-neutral-400 bg-neutral-100/90 px-2 py-1 text-[11px] leading-tight text-neutral-600 dark:border-neutral-600 dark:bg-neutral-900/80 dark:text-neutral-300"
                title={label}
              >
                <div className="truncate font-medium">{label}</div>
                <div className="truncate text-[10px] tabular-nums opacity-70">
                  {timeRangeLabel(
                    formatTimeForStudio(start, tz, timeFormat),
                    formatTimeForStudio(end, tz, timeFormat),
                  )}
                </div>
              </div>
            );
          })}

        {/* One-off timed blocks — tappable → edit drawer (owner-gated inside). */}
        {timedBlocks.map((tb) => {
          const start = new Date(tb.starts_at);
          const end = new Date(tb.ends_at);
          const [h, m] = localTimeString(start, tz).split(":").map(Number);
          const startMin = (h - HOUR_START) * 60 + m;
          if (startMin < 0 || startMin >= VISIBLE_MINUTES) return null;
          const durationMinutes = Math.max(
            5,
            Math.round((end.getTime() - start.getTime()) / 60_000),
          );
          const top = (startMin / ROW_MINUTES) * ROW_HEIGHT_PX;
          const height = Math.max(
            ROW_HEIGHT_PX - 2,
            (durationMinutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
          );
          const label = TIMED_BLOCK_LABEL[tb.category] ?? "Unavailable";
          return (
            <button
              key={tb.id}
              type="button"
              onClick={() => onEditBlock(tb)}
              style={{ top, height }}
              className="absolute inset-x-1 z-10 flex flex-col items-start overflow-hidden rounded-md border border-neutral-400 bg-neutral-200/95 px-2 py-1 text-left text-[11px] leading-tight text-neutral-700 shadow-sm dark:border-neutral-600 dark:bg-neutral-800/95 dark:text-neutral-200"
              title={tb.private_note ? `${label}: ${tb.private_note}` : label}
            >
              <span className="truncate font-medium">{label}</span>
              <span className="truncate text-[10px] tabular-nums opacity-70">
                {timeRangeLabel(
                  formatTimeForStudio(start, tz, timeFormat),
                  formatTimeForStudio(end, tz, timeFormat),
                )}
              </span>
            </button>
          );
        })}

        {/* Appointments — tap → existing detail page (with returnTo). */}
        {appts.map((a) => {
          const start = new Date(a.starts_at);
          const [h, m] = localTimeString(start, tz).split(":").map(Number);
          const startMin = (h - HOUR_START) * 60 + m;
          if (startMin < 0 || startMin >= VISIBLE_MINUTES) return null;
          const top = (startMin / ROW_MINUTES) * ROW_HEIGHT_PX;
          const height = Math.max(
            ROW_HEIGHT_PX - 2,
            (a.duration_minutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
          );
          const clientName = a.client?.name?.trim() || "Client";
          const serviceName = a.service?.name?.trim() || null;
          const dispStart = formatTimeForStudio(start, tz, timeFormat);
          const dispEnd = a.ends_at
            ? formatTimeForStudio(new Date(a.ends_at), tz, timeFormat)
            : null;
          const timeRange = timeRangeLabel(dispStart, dispEnd);
          const ds = appointmentDisplayStatus(a.status, a.ends_at);
          const terminal = ds !== "upcoming";
          const statusTag =
            ds === "done"
              ? "Done"
              : ds === "completed"
                ? "Completed"
                : ds === "no_show"
                  ? "No-show"
                  : null;
          return (
            <Link
              key={a.id}
              href={`/calendar/${a.id}${returnTo}`}
              style={{ top, height }}
              className={`absolute inset-x-1 z-10 overflow-hidden rounded-lg border-l-4 ${serviceCardClasses(a.service?.id ?? null, a.service?.name ?? null)} px-2 py-1 text-[12px] leading-tight shadow-sm transition active:brightness-95 ${terminal ? "opacity-60" : ""}`}
            >
              <div className="truncate text-[10px] font-semibold tabular-nums opacity-80">
                {timeRange}
                {statusTag ? ` · ${statusTag}` : ""}
              </div>
              <div className="truncate font-semibold">{clientName}</div>
              {serviceName && height >= 46 && (
                <div className="truncate text-[10px] opacity-70">
                  {serviceName}
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { calendarCollisionGroups, timedBlockCollisionId } from "@/lib/calendar/appointment-lanes";
import { AppointmentOverlapChooser } from "./AppointmentOverlapChooser";
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
import { appointmentCardClasses } from "@/lib/calendar/service-colors";
import {
  CARD_LINE_PX,
  calendarPractitionerIdentity,
  practitionerRowFits,
} from "@/lib/calendar/practitioner-identity";
import {
  NO_SHOW_CARD_CLASS,
  appointmentDisplayStatus,
  appointmentStatusTag,
} from "./appointment-display-status";
import { PractitionerTag } from "./PractitionerTag";
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
import { calendarBlockScopeLabel, type BlockScopeNames } from "@/lib/calendar/block-scope";
import type { DayAvailability } from "./DayColumn";

// Single-day mobile timeline (PR: mobile calendar redesign). Renders ONE
// selected day as a vertical 1px=1min timeline: the same positioning model as
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
  // HON-48: team calendar (practitioner capacity on) → name + color swatch.
  showPractitioner?: boolean;
  // BLOCK-SCOPE F3: under practitioner capacity, names each block's scope
  // ("All practitioners" / "Only <name>"). Absent: no scope label.
  blockScopeNames?: BlockScopeNames;
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
  showPractitioner = false,
  blockScopeNames,
  onBookAt,
  onEditBlock,
}: Props) {
  const dayRef = useRef<HTMLDivElement>(null);
  const [overlapIds, setOverlapIds] = useState<string[] | null>(null);

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

  const rectangles = appts.flatMap((a) => {
    const start = new Date(a.starts_at);
    const [h, m] = localTimeString(start, tz).split(":").map(Number);
    const startMin = (h - HOUR_START) * 60 + m;
    if (startMin < 0 || startMin >= VISIBLE_MINUTES) return [];
    return [{ id: a.id, top: (startMin / ROW_MINUTES) * ROW_HEIGHT_PX,
      height: Math.max(ROW_HEIGHT_PX - 2, (a.duration_minutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2) }];
  });
  const timedBlockRectangles = timedBlocks.flatMap(block => {
    const start = new Date(block.starts_at);
    const end = new Date(block.ends_at);
    const [h, m] = localTimeString(start, tz).split(":").map(Number);
    const minutes = (h - HOUR_START) * 60 + m;
    if (minutes < 0 || minutes >= VISIBLE_MINUTES) return [];
    const duration = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000));
    return [{ id: block.id, top: (minutes / ROW_MINUTES) * ROW_HEIGHT_PX,
      height: Math.max(ROW_HEIGHT_PX - 2, (duration / ROW_MINUTES) * ROW_HEIGHT_PX - 2) }];
  });
  const groups = calendarCollisionGroups(rectangles, timedBlockRectangles);
  const groupedBlockIds = new Set(groups.filter(group => group.ids.length > 1).flatMap(group => group.ids));
  const appointmentsById = new Map(appts.map((a) => [a.id, a]));
  const blocksById = new Map(timedBlocks.map(block => [timedBlockCollisionId(block.id), block]));
  const selectedBlocks = (overlapIds ?? []).flatMap(id => {
    const block = blocksById.get(id);
    return block ? [block] : [];
  });
  const selectedOverlaps = (overlapIds ?? []).flatMap((id) => {
    const a = appointmentsById.get(id);
    return a ? [a] : [];
  });

  return (
    <div className="relative flex" data-testid="mobile-day-timeline" data-date={date}>
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
            const scope = blockScopeNames ? calendarBlockScopeLabel(occ.practitioner_id, blockScopeNames) : null;
            return (
              <div
                key={occ.id}
                style={{ top, height }}
                className="absolute inset-x-1 z-10 overflow-hidden rounded-md border border-dashed border-neutral-400 bg-neutral-100/90 px-2 py-1 text-[11px] leading-tight text-neutral-600 dark:border-neutral-600 dark:bg-neutral-900/80 dark:text-neutral-300"
                title={scope ? `${label} · ${scope}` : label}
              >
                <div className="truncate font-medium">
                  {label}
                  {scope && <span data-block-scope="" className="font-normal"> · {scope}</span>}
                </div>
                <div className="truncate text-[10px] tabular-nums opacity-70">
                  {timeRangeLabel(
                    formatTimeForStudio(start, tz, timeFormat),
                    formatTimeForStudio(end, tz, timeFormat),
                  )}
                </div>
              </div>
            );
          })}

        {/* One-off timed blocks: tappable → edit drawer (owner-gated inside). */}
        {timedBlocks.map((tb) => {
          if (groupedBlockIds.has(timedBlockCollisionId(tb.id))) return null;
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
          const scope = blockScopeNames ? calendarBlockScopeLabel(tb.practitioner_id, blockScopeNames) : null;
          return (
            <button
              key={tb.id}
              type="button"
              onClick={() => onEditBlock(tb)}
              style={{ top, height }}
              className="absolute inset-x-1 z-10 min-h-[44px] min-w-[44px] flex flex-col items-start overflow-hidden rounded-md border border-neutral-400 bg-neutral-200/95 px-2 py-1 text-left text-[11px] leading-tight text-neutral-700 shadow-sm dark:border-neutral-600 dark:bg-neutral-800/95 dark:text-neutral-200"
              title={[tb.private_note ? `${label}: ${tb.private_note}` : label, scope].filter(Boolean).join(" · ")}
            >
              <span className="truncate font-medium">
                {label}
                {scope && <span data-block-scope="" className="font-normal"> · {scope}</span>}
              </span>
              <span className="truncate text-[10px] tabular-nums opacity-70">
                {timeRangeLabel(
                  formatTimeForStudio(start, tz, timeFormat),
                  formatTimeForStudio(end, tz, timeFormat),
                )}
              </span>
            </button>
          );
        })}

        {/* Appointments: tap → existing detail page (with returnTo). */}
        {groups.map((group) => {
          if (group.ids.some(id => blocksById.has(id)) && group.ids.length > 1) return (
            <button key={group.ids.join(":")} type="button" style={{ top: group.top, height: group.height }}
              aria-label={`Choose from ${group.ids.length} calendar items`}
              className="absolute inset-x-1 z-10 min-h-[44px] min-w-[44px] overflow-hidden rounded-lg border-l-4 border-neutral-500 bg-neutral-100 px-2 py-1 text-left text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
              onClick={(event) => { event.stopPropagation(); setOverlapIds(group.ids); }}>
              <span className="block font-semibold">{group.ids.length} calendar items</span>
            </button>
          );
          if (group.ids.every(id => blocksById.has(id))) return null;

          const members = group.ids.map((id) => appointmentsById.get(id)!);
          const a = members[0];
          const start = new Date(a.starts_at);
          const top = group.top;
          const height = group.height;
          if (members.length > 1) return (
            <button key={group.ids.join(":")} type="button" style={{ top, height }}
              aria-label={`Choose from ${members.length} appointments`}
              className="absolute inset-x-1 z-10 min-h-[44px] min-w-[44px] overflow-hidden rounded-lg border-l-4 border-neutral-500 bg-neutral-100 px-2 py-1 text-left text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
              onClick={(event) => { event.stopPropagation(); setOverlapIds(group.ids); }}>
              <span className="block font-semibold">{members.length} appointments</span>
              <span className="block tabular-nums">{formatTimeForStudio(start, tz, timeFormat)}</span>
            </button>
          );
          const clientName = a.client?.name?.trim() || "Client";
          const serviceName = a.service?.name?.trim() || null;
          const practitionerIdentity = showPractitioner
            ? calendarPractitionerIdentity(a.practitioner)
            : null;
          const dispStart = formatTimeForStudio(start, tz, timeFormat);
          const dispEnd = a.ends_at
            ? formatTimeForStudio(new Date(a.ends_at), tz, timeFormat)
            : null;
          const timeRange = timeRangeLabel(dispStart, dispEnd);
          const showService = serviceName !== null && height >= 46;
          const practitionerRow =
            practitionerIdentity !== null &&
            practitionerRowFits(height, {
              bodyLinePx: CARD_LINE_PX.mobileBody,
              serviceRow: showService,
            });
          const ds = appointmentDisplayStatus(a.status, a.ends_at);
          const terminal = ds !== "upcoming";
          const statusTag = appointmentStatusTag(ds);
          const noShow = ds === "no_show";
          // No-show leads the line instead (see NO_SHOW_CARD_CLASS).
          const trailingTag = noShow ? null : statusTag;
          return (
            <Link
              key={a.id}
              href={`/calendar/${a.id}${returnTo}`}
              style={{ top, height }}
              className={`absolute inset-x-1 z-10 min-h-[44px] min-w-[44px] overflow-hidden rounded-lg border-l-4 ${appointmentCardClasses(a.service)} px-2 py-1 text-[12px] leading-tight shadow-sm transition active:brightness-95 ${terminal ? "opacity-60" : ""} ${noShow ? NO_SHOW_CARD_CLASS : ""}`}
            >
              <div className="flex min-w-0 items-center gap-1 text-[10px] font-semibold tabular-nums opacity-80">
                {noShow && <span className="shrink-0">No-show ·</span>}
                <span className="truncate">
                  {timeRange}
                  {trailingTag ? ` · ${trailingTag}` : ""}
                </span>
                {practitionerIdentity && !practitionerRow && (
                  // Too short for its own row: the name rides the time row.
                  <PractitionerTag
                    identity={practitionerIdentity}
                    className="font-medium"
                  />
                )}
              </div>
              <div className="truncate font-semibold">{clientName}</div>
              {practitionerIdentity && practitionerRow && (
                <PractitionerTag
                  identity={practitionerIdentity}
                  className="text-[10px] font-medium"
                />
              )}
              {showService && (
                <div className="truncate text-[10px] opacity-70">
                  {serviceName}
                </div>
              )}
            </Link>
          );
        })}
      </div>
      <AppointmentOverlapChooser blockScopeNames={blockScopeNames} timedBlocks={selectedBlocks} onSelectBlock={onEditBlock} appointments={selectedOverlaps} tz={tz} timeFormat={timeFormat} returnTo={returnTo}
        onClose={() => setOverlapIds(null)} />
    </div>
  );
}

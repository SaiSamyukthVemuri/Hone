"use client";

import { useEffect, useState } from "react";
import { HOUR_END, HOUR_START, VISIBLE_MINUTES } from "./calendar-constants";

// Horizontal "Now" line drawn across a calendar DayColumn for the
// current studio-local time. Rendered only by DayColumn and only
// when the parent decides isToday is true (the parent already
// computes that against studio timezone, so we never need to
// re-check the date here; we just compute the minute-of-day in the
// same timezone).
//
// Coordinate system: the calendar grid is 1px = 1min from
// HOUR_START * 60 (top) to HOUR_END * 60 (bottom). When current time
// falls outside that window, the line is hidden rather than clamped
// to an edge.
//
// Lightweight client surface: the component owns its own 60-second
// tick + minute computation. The rest of DayColumn / calendar page
// remains exactly as it was; nothing about availability, slot
// generation, booking actions, or appointment lifecycle is touched.

type Props = {
  // IANA timezone string used by the calendar grid (studio.timezone).
  tz: string;
};

// Compute the current minute-of-day (0..1439) in the given timezone.
// Uses Intl.DateTimeFormat so DST transitions are handled correctly;
// we never lean on naive server time or browser-local Date math.
function minuteOfDayInTz(tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  const hNum = parseInt(h, 10);
  const mNum = parseInt(m, 10);
  if (!Number.isFinite(hNum) || !Number.isFinite(mNum)) return 0;
  return hNum * 60 + mNum;
}

export function NowLine({ tz }: Props) {
  // Initial null avoids a hydration mismatch: server renders nothing,
  // the client mounts, sets the minute on first effect, and the line
  // appears. The line is visual polish; a one-frame absence after a
  // hard refresh is acceptable.
  const [minute, setMinute] = useState<number | null>(null);

  useEffect(() => {
    function tick() {
      setMinute(minuteOfDayInTz(tz));
    }
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [tz]);

  if (minute == null) return null;

  const gridTopMinutes = HOUR_START * 60;
  const gridBottomMinutes = HOUR_END * 60;
  // Hide if we are outside visible hours; the calendar tints those
  // regions already, no need for an out-of-range Now line clamped to
  // an edge (which would mislead the eye).
  if (minute < gridTopMinutes || minute >= gridBottomMinutes) return null;

  const topPx = minute - gridTopMinutes;
  // Defensive clamp: VISIBLE_MINUTES is the grid extent; the line is
  // 2px tall, so top must allow room for it. Effectively a no-op
  // given the early-return above, but cheap insurance.
  const safeTop = Math.max(0, Math.min(VISIBLE_MINUTES - 2, topPx));

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-0 right-0 z-20"
      style={{ top: `${safeTop}px` }}
    >
      <div className="flex items-center gap-1">
        <span className="rounded-sm bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white shadow-sm dark:bg-neutral-100 dark:text-neutral-900">
          Now
        </span>
        <div className="h-px flex-1 bg-neutral-900 dark:bg-neutral-100" />
      </div>
    </div>
  );
}

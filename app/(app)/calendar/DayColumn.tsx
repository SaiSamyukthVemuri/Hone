"use client";

// Single-day column for the calendar week view.
//
// Extracted from the inline definition that previously lived in
// app/(app)/calendar/page.tsx so empty-cell click handling can run
// client-side without making the entire page client-rendered. The
// rendering logic for blockouts, appointments, and the day grid
// is byte-equivalent to the pre-extraction version — only the
// surrounding wrapper added an absolute-positioned click overlay
// at z-0 (below the z-[5] blockouts and z-10 appointment Links)
// so clicks land on event cards first and only fall through to
// the overlay on truly empty space.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Service, StudioTimedBlock } from "@/lib/types/database";
import type {
  AppointmentWithPractitionerColor,
  RecurringBreakOccurrenceWithRule,
} from "@/lib/booking/queries";
import { localTimeString } from "@/lib/booking/tz";
import { appointmentDisplayStatus } from "./appointment-display-status";
import {
  QuickBookDrawer,
  type QuickBookClient,
  type QuickBookDraft,
} from "./QuickBookDrawer";
import { DragActionChooser } from "./DragActionChooser";
import { QuickBlockDrawer } from "./QuickBlockDrawer";
// Grid constants live in a plain (non-"use client") module. The server
// component calendar/page.tsx must import them from there, NOT from this
// client module — a client-module value imported by a Server Component
// becomes a client-reference proxy, not the real number, which silently
// broke the rail's hour loop. This client component imports them too so
// there is a single source of truth.
import {
  GRID_HEIGHT,
  HOUR_END,
  HOUR_START,
  ROW_HEIGHT_PX,
  ROW_MINUTES,
  VISIBLE_MINUTES,
} from "./calendar-constants";
import { NowLine } from "./NowLine";
import { serviceCardClasses } from "@/lib/calendar/service-colors";

// Day-of-week labels + the "Mon · May 26" / "8 AM" formatters live in
// ./calendar-format (also a plain, non-"use client" module) for the same
// server/client-boundary reason. This client component doesn't need them.

// Appointment-card colors are now keyed off SERVICE, not
// practitioner. See lib/calendar/service-colors.ts. The prior
// per-practitioner SOFT_CARD_BY_TOKEN / softCardClasses helper was
// removed here when this card stopped reading practitioner color;
// future multi-practitioner UIs can either re-introduce a left-
// accent border in practitioner color or read directly from
// lib/practitioner-colors.ts.

// "HH:MM:SS" (studio-local availability time) → minutes from midnight,
// or null when unparseable. Visual-only: used to position the neutral
// availability tint. Never feeds booking math.
function timeToMinutes(hhmmss: string | null): number | null {
  if (!hhmmss) return null;
  const parts = hhmmss.split(":");
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Read-only weekly availability for one weekday, passed from the page.
// `null` means "no default configured" → render no tint (keep the
// existing blank look rather than fabricating a closed/open state).
export type DayAvailability = {
  isOpen: boolean;
  openTime: string | null; // "HH:MM:SS"
  closeTime: string | null;
};

const TIMED_BLOCK_LABEL: Record<string, string> = {
  lunch: "Lunch",
  break: "Break",
  meeting: "Meeting",
  emergency: "Emergency",
  personal: "Personal",
  training: "Training",
  admin: "Admin",
  other: "Unavailable",
};

// Migration 0037 (Breaks & blocks cleanup) widened the recurring-
// break label column to free text. KNOWN_RECURRING_BREAK_LABELS keeps
// the old enum values rendering with their pre-existing capitalized
// display ("lunch" → "Lunch", etc.). Custom labels typed by the
// practitioner ("Dinner", "School pickup") fall through to
// displayRecurringBreakLabel which preserves their casing.
const KNOWN_RECURRING_BREAK_LABELS: Record<string, string> = {
  lunch: "Lunch",
  break: "Break",
  admin: "Admin",
  other: "Break",
};

function displayRecurringBreakLabel(rawLabel: string | null | undefined): string {
  if (!rawLabel) return "Break";
  const t = rawLabel.trim();
  if (t.length === 0) return "Break";
  const known = KNOWN_RECURRING_BREAK_LABELS[t.toLowerCase()];
  if (known) return known;
  // Custom label: preserve practitioner-supplied casing (e.g. "Dinner"
  // typed as-is), but capitalize the first letter for tidy display if
  // the practitioner typed all-lowercase.
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// PR #10 idiom: blockouts use a 40px height threshold to choose
// between two-line and one-line layouts. Same threshold applied
// here so the BlockoutCard render is byte-identical to the
// previously-inline version.
const TWO_LINE_THRESHOLD_PX = 40;

// Snaps an arbitrary minute-of-day to the same 15-minute grid the
// public booking flow uses (SLOT_GRANULARITY_MINUTES in
// lib/booking/slots.ts). Used for both bare-click time and the
// drag-selection start/end times so the value the drawer receives is
// always a 15-min multiple.
const CLICK_SNAP_MINUTES = 15;

// Pixel distance (== minutes here, since 1 px = 1 minute) below which
// a pointer-down → pointer-up gesture is treated as a bare click
// rather than a drag. Keeps an accidental 1-2 px wiggle on touchpad
// from creating a sliver-duration draft.
const DRAG_THRESHOLD_PX = 3;

// Minimum drag duration in minutes. A drag that snaps to a smaller
// range collapses to the bare-click flow so single-click semantics
// are preserved when the practitioner barely moved.
const MIN_DRAG_DURATION_MINUTES = 15;

// Maximum drag duration in minutes. Mirrors the booking action's
// duration_minutes_override cap so the drawer never opens with a
// value the server will reject; the practitioner can still type a
// shorter or longer value (within the same bounds) in the override
// field before saving.
const MAX_DRAG_DURATION_MINUTES = 360;

function snapMinutesFloor(n: number): number {
  return Math.floor(n / CLICK_SNAP_MINUTES) * CLICK_SNAP_MINUTES;
}

function snapMinutesCeil(n: number): number {
  return Math.ceil(n / CLICK_SNAP_MINUTES) * CLICK_SNAP_MINUTES;
}

function minutesToHHMM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

type Props = {
  date: string;
  appts: AppointmentWithPractitionerColor[];
  timedBlocks: StudioTimedBlock[];
  recurringBreaks: RecurringBreakOccurrenceWithRule[];
  blocked: boolean;
  tz: string;
  clients: QuickBookClient[];
  services: Service[];
  // Calendar Readability Repair: read-only visual context. Neither
  // affects booking — empty-slot clicks still open the drawer at any
  // time in the visible range, exactly as before.
  isToday: boolean;
  availability: DayAvailability | null;
  // True when this date resolves to closed (override-aware, same precedence
  // as public booking). Display-only: used to hide auto-materialized
  // recurring breaks on closed dates. Does not affect booking or data.
  closedDay: boolean;
};

// Drag-selection state. `pointerId` matches the in-flight pointer so a
// multi-touch start cannot interleave; `startY` is the pointer-down Y
// in grid pixels (column-local), `currentY` updates on every move so
// the translucent overlay re-renders. `null` means no drag is in
// progress.
type DragState = {
  pointerId: number;
  startY: number;
  currentY: number;
};

export function DayColumn({
  date,
  appts,
  timedBlocks,
  recurringBreaks,
  blocked,
  tz,
  clients,
  services,
  isToday,
  availability,
  closedDay,
}: Props) {
  const [draft, setDraft] = useState<QuickBookDraft | null>(null);
  // PR #139. Drag-created drafts route through a chooser ("Book
  // appointment" vs "Block time") instead of opening the quick-book
  // drawer immediately. chooserDraft holds the dragged range while
  // the chooser is up; blockDraft is set when the practitioner picks
  // Block time. Bare clicks (no drag duration) skip the chooser and
  // open the quick-book drawer directly via setDraft above.
  const [chooserDraft, setChooserDraft] = useState<{
    date: string;
    startLocal: string;
    endLocal: string;
    durationMinutes: number;
  } | null>(null);
  const [blockDraft, setBlockDraft] = useState<{
    localDate: string;
    startLocal: string;
    endLocal: string;
  } | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  // The empty-cell button. Used to compute pointer-local Y in a way
  // that survives the pointer drifting outside the button (with
  // pointer capture). The ref is set on the button below.
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Neutral availability tint regions (visual guidance only; gray, never
  // a status color). A closed weekday tints the whole grid; an open day
  // tints only the out-of-hours portions (before open, after close),
  // leaving the working window clear so it reads as clickable. `null`
  // availability → no tint.
  const gridTopMinutes = HOUR_START * 60;
  const tintRegions: Array<{ top: number; height: number }> = [];
  if (availability) {
    if (!availability.isOpen) {
      tintRegions.push({ top: 0, height: GRID_HEIGHT });
    } else {
      const open = timeToMinutes(availability.openTime);
      const close = timeToMinutes(availability.closeTime);
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

  // Compute pointer-local Y in column-grid pixels (1 px = 1 minute).
  // Reads the button's current bounding rect each call so the value
  // stays correct after scrolling or window resize.
  const pointerLocalY = useCallback((clientY: number): number => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return clientY - rect.top;
  }, []);

  // Open the drawer for a bare click at the snapped time. Preserves
  // the pre-drag single-click behaviour; never sends a duration so
  // the drawer flows through the standard slot picker.
  const openDraftAtY = useCallback(
    (y: number) => {
      const minutesFromGridTop = Math.max(0, Math.min(VISIBLE_MINUTES - 1, y));
      const totalMinutes = HOUR_START * 60 + minutesFromGridTop;
      const snapped = snapMinutesFloor(totalMinutes);
      if (snapped < HOUR_START * 60 || snapped >= HOUR_END * 60) return;
      setDraft({ localDate: date, localTime: minutesToHHMM(snapped) });
    },
    [date],
  );

  // Open the drawer with a drag-selected range. Snaps the start down
  // and the end up so the dragged range never shrinks below the
  // practitioner's intent; clamps the start to HOUR_START..HOUR_END
  // and the end to HOUR_END; caps duration to MAX_DRAG_DURATION; and
  // falls through to the bare-click path when the resulting duration
  // is below MIN_DRAG_DURATION (a tiny wiggle stays a click).
  const openDraftFromDrag = useCallback(
    (rawStartY: number, rawEndY: number) => {
      const startY = Math.min(rawStartY, rawEndY);
      const endY = Math.max(rawStartY, rawEndY);
      const startMinFromTop = Math.max(0, Math.min(VISIBLE_MINUTES, startY));
      const endMinFromTop = Math.max(0, Math.min(VISIBLE_MINUTES, endY));
      const snappedStartTotal = snapMinutesFloor(
        HOUR_START * 60 + startMinFromTop,
      );
      const snappedEndTotal = Math.min(
        HOUR_END * 60,
        snapMinutesCeil(HOUR_START * 60 + endMinFromTop),
      );
      if (
        snappedStartTotal < HOUR_START * 60 ||
        snappedStartTotal >= HOUR_END * 60
      ) {
        return;
      }
      let duration = snappedEndTotal - snappedStartTotal;
      if (duration < MIN_DRAG_DURATION_MINUTES) {
        // Collapsed too small to count as a drag; treat as a click at
        // the start point.
        openDraftAtY(startY);
        return;
      }
      if (duration > MAX_DRAG_DURATION_MINUTES) {
        duration = MAX_DRAG_DURATION_MINUTES;
      }
      // PR #139. Drag-created drafts open the chooser; the
      // practitioner then decides Book vs Block. Bare clicks
      // (openDraftAtY above) still bypass the chooser.
      setChooserDraft({
        date,
        startLocal: minutesToHHMM(snappedStartTotal),
        endLocal: minutesToHHMM(snappedEndTotal),
        durationMinutes: duration,
      });
    },
    [date, openDraftAtY],
  );

  function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Left mouse button + primary touch only. Ignore right/middle
    // click and any non-primary touch so contextmenu and multi-finger
    // gestures still work normally.
    if (e.button !== 0) return;
    const y = pointerLocalY(e.clientY);
    // Capture the pointer so subsequent moves/up still fire on this
    // element even if the cursor drifts outside the column.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw in some test envs; the drag still
      // works without capture, the overlay just stops updating if the
      // cursor leaves the column.
    }
    setDragState({ pointerId: e.pointerId, startY: y, currentY: y });
  }

  function handlePointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const y = pointerLocalY(e.clientY);
    setDragState({ ...dragState, currentY: y });
  }

  function handlePointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const finalY = pointerLocalY(e.clientY);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // releasePointerCapture can throw if capture was never set.
    }
    const startY = dragState.startY;
    setDragState(null);
    const distance = Math.abs(finalY - startY);
    if (distance < DRAG_THRESHOLD_PX) {
      // Bare click: keep the pre-drag semantics. Open the drawer at
      // the snapped time, no duration; standard slot flow runs.
      openDraftAtY(startY);
      return;
    }
    openDraftFromDrag(startY, finalY);
  }

  function handlePointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    setDragState(null);
  }

  // Keyboard activation: Enter / Space mimic a click at the top of
  // the visible range, matching the pre-drag fallback. Pointer events
  // do not handle keyboard, so this path is the only way a keyboard
  // user opens the drawer.
  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openDraftAtY(0);
  }

  // Reset drag state if the parent re-renders into a new date/key, so
  // a drag in flight on the previous render does not leak into the
  // next. (DayColumn keys by date so this is mostly defensive.)
  useEffect(() => {
    return () => {
      setDragState(null);
    };
  }, [date]);

  // Live drag-overlay geometry, computed only while a drag is in
  // flight. Snaps start down and end up to 15-min boundaries so the
  // overlay matches what the drawer will receive on release.
  const overlay = (() => {
    if (!dragState) return null;
    const a = Math.min(dragState.startY, dragState.currentY);
    const b = Math.max(dragState.startY, dragState.currentY);
    if (Math.abs(b - a) < DRAG_THRESHOLD_PX) return null;
    const startMin = Math.max(0, Math.min(VISIBLE_MINUTES, a));
    const endMin = Math.max(0, Math.min(VISIBLE_MINUTES, b));
    const snappedStart = snapMinutesFloor(HOUR_START * 60 + startMin);
    const snappedEnd = Math.min(
      HOUR_END * 60,
      snapMinutesCeil(HOUR_START * 60 + endMin),
    );
    const top = (snappedStart - HOUR_START * 60) * (ROW_HEIGHT_PX / ROW_MINUTES);
    const height =
      (snappedEnd - snappedStart) * (ROW_HEIGHT_PX / ROW_MINUTES);
    return {
      top,
      height,
      startLabel: minutesToHHMM(snappedStart),
      endLabel: minutesToHHMM(snappedEnd),
      durationMinutes: snappedEnd - snappedStart,
    };
  })();

  return (
    <div
      className="relative border-l border-neutral-100 dark:border-neutral-800/60"
      style={{ height: GRID_HEIGHT }}
    >
      {/* Today's column gets a faint cool (sky) wash, Google-style, so the
          current day is easy to spot at a glance and reads as distinct from
          the neutral-gray "unavailable" tint. Sits at the very bottom so the
          availability tint and events read on top. pointer-events-none;
          never blocks clicks; no ring / badge / extra height. */}
      {isToday && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 bg-sky-50/70 dark:bg-sky-950/25"
        />
      )}

      {/* Horizontal "Now" line. Rendered only on today's column so
          past/future columns never see it. Its position is computed
          in the same studio timezone the grid uses; the line hides
          when the current time falls outside HOUR_START..HOUR_END.
          Updates every minute via a small client interval. */}
      {isToday && <NowLine tz={tz} />}

      {/* Neutral availability tint (visual guidance only). Very subtle so
          available hours stay the main canvas. pointer-events-none so the
          empty-slot click overlay below still receives clicks everywhere
          in the visible range — booking behavior is unchanged. */}
      {tintRegions.map((r, i) => (
        <div
          key={`tint-${i}`}
          aria-hidden
          style={{ top: r.top, height: r.height }}
          className="pointer-events-none absolute inset-x-0 z-0 bg-neutral-100/80 dark:bg-neutral-800/50"
        />
      ))}

      {/* Hour / half-hour grid lines — soft and low-contrast (Google-like).
          Hour boundaries (even rows) are faintly visible; the :30 lines are
          nearly invisible. */}
      {Array.from(
        { length: VISIBLE_MINUTES / ROW_MINUTES },
        (_, i) => i,
      ).map((i) => (
        <div
          key={i}
          style={{
            top: i * ROW_HEIGHT_PX,
            height: ROW_HEIGHT_PX,
          }}
          className={
            "absolute inset-x-0 border-b " +
            (i % 2 === 1
              ? "border-neutral-100/70 dark:border-neutral-800/30"
              : "border-neutral-200/70 dark:border-neutral-800/60")
          }
        />
      ))}

      {/* Empty-cell pointer + keyboard overlay. Sits at z-0, beneath
          every event card so it ONLY receives pointer events on
          transparent empty space. Single-click semantics are
          preserved: a pointer-down → pointer-up with sub-threshold
          movement opens the drawer at the snapped time with no
          duration (standard slot picker). A drag opens the drawer
          with a duration so the drag-to-create flow auto-enables the
          override path and pre-fills the time range. Keyboard users
          activate via Enter/Space (opens at the top of the visible
          range, same as the pre-drag fallback). */}
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Open quick-book draft for ${date}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
        // Disable native browser drag image when the practitioner
        // drags inside the cell; we run our own drag-selection model
        // and don't want the cursor to switch to the no-drop sigil.
        onDragStart={(e) => e.preventDefault()}
        style={{ touchAction: "none" }}
        className="absolute inset-0 z-0 cursor-pointer select-none rounded-none outline-none transition-colors hover:bg-sky-100/40 focus-visible:bg-sky-100/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-300 dark:hover:bg-sky-900/20 dark:focus-visible:bg-sky-900/20 dark:focus-visible:ring-sky-700"
      />

      {/* Live drag-selection overlay. Translucent block + time-range
          label that tracks the snapped start/end as the practitioner
          drags. Sits ABOVE the empty-cell button but BELOW the
          appointment cards (z-[6] vs z-10) so an existing card stays
          on top: the overlay can extend across a card visually, and
          the server-side conflict logic rejects the booking on
          release if the chosen range overlaps anything. */}
      {overlay && (
        <div
          aria-hidden
          style={{ top: overlay.top, height: overlay.height }}
          className="pointer-events-none absolute inset-x-1 z-[6] flex items-start rounded-md border border-sky-400/70 bg-sky-200/40 px-2 py-1 text-[11px] font-medium text-sky-900 shadow-sm dark:border-sky-500/70 dark:bg-sky-500/20 dark:text-sky-100"
        >
          <span className="truncate tabular-nums">
            {overlay.startLabel} to {overlay.endLabel} ·{" "}
            {overlay.durationMinutes} min
          </span>
        </div>
      )}

      {blocked && (
        // PR #138 Part 2. Whole-day closed-or-blocked overlay. The
        // previous bg-neutral-50/80 read so close to the empty grid
        // gray that the day looked normal. We swap to a warm tan
        // wash + a soft slate-warm diagonal stripe so the slot is
        // unmistakably unavailable without shouting in red. Text
        // colour bumped from neutral-500 to a solid dark gray so
        // the Blocked label remains legible over the stripes.
        <div
          aria-label="Blocked day"
          className="absolute inset-0 z-[3] dark:bg-stone-900/55"
          style={{
            backgroundColor: "#F4F1EA",
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent 0, transparent 7px, rgba(140, 133, 121, 0.22) 7px, rgba(140, 133, 121, 0.22) 9px)",
          }}
        >
          <div
            className="px-2 pt-2 text-[11px] font-medium uppercase tracking-wider"
            style={{ color: "#3F3F3F" }}
          >
            Blocked
          </div>
        </div>
      )}

      {/* Auto-materialized recurring breaks are hidden on closed dates:
          recurring break rules materialize for every matching weekday
          regardless of availability, so a standing Dinner/Lunch break would
          otherwise show on a day the studio isn't open. Closed days are kept
          unbookable by availability logic (lib/booking/slots.ts), not by
          these reservations, so hiding them is display-safe. One-off timed
          blocks below are NOT hidden — those are intentional. */}
      {!closedDay && recurringBreaks.map((occ) => {
        const start = new Date(occ.starts_at);
        const end = new Date(occ.ends_at);
        const localTime = localTimeString(start, tz);
        const localEndTime = localTimeString(end, tz);
        const [h, m] = localTime.split(":").map(Number);
        const startMinutesFromGridTop = (h - HOUR_START) * 60 + m;
        if (
          startMinutesFromGridTop < 0 ||
          startMinutesFromGridTop >= VISIBLE_MINUTES
        ) {
          return null;
        }
        const durationMinutes = Math.max(
          5,
          Math.round((end.getTime() - start.getTime()) / 60_000),
        );
        const top = (startMinutesFromGridTop / ROW_MINUTES) * ROW_HEIGHT_PX;
        const height = Math.max(
          ROW_HEIGHT_PX - 2,
          (durationMinutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
        );
        const label = displayRecurringBreakLabel(occ.rule?.label);
        return (
          <BlockoutCard
            key={occ.id}
            label={label}
            title={label}
            startLocal={localTime}
            endLocal={localEndTime}
            durationMinutes={durationMinutes}
            top={top}
            height={height}
          />
        );
      })}

      {timedBlocks.map((tb) => {
        const start = new Date(tb.starts_at);
        const end = new Date(tb.ends_at);
        const localTime = localTimeString(start, tz);
        const localEndTime = localTimeString(end, tz);
        const [h, m] = localTime.split(":").map(Number);
        const startMinutesFromGridTop = (h - HOUR_START) * 60 + m;
        if (
          startMinutesFromGridTop < 0 ||
          startMinutesFromGridTop >= VISIBLE_MINUTES
        ) {
          return null;
        }
        const durationMinutes = Math.max(
          5,
          Math.round((end.getTime() - start.getTime()) / 60_000),
        );
        const top = (startMinutesFromGridTop / ROW_MINUTES) * ROW_HEIGHT_PX;
        const height = Math.max(
          ROW_HEIGHT_PX - 2,
          (durationMinutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
        );
        const label = TIMED_BLOCK_LABEL[tb.category] ?? "Unavailable";
        const titleNote = tb.private_note
          ? `${label}: ${tb.private_note}`
          : label;
        return (
          <BlockoutCard
            key={tb.id}
            label={label}
            title={titleNote}
            startLocal={localTime}
            endLocal={localEndTime}
            durationMinutes={durationMinutes}
            top={top}
            height={height}
          />
        );
      })}

      {appts.map((a) => {
        const start = new Date(a.starts_at);
        const localTime = localTimeString(start, tz);
        const [h, m] = localTime.split(":").map(Number);
        const startMinutesFromGridTop = (h - HOUR_START) * 60 + m;
        if (
          startMinutesFromGridTop < 0 ||
          startMinutesFromGridTop >= VISIBLE_MINUTES
        ) {
          return null;
        }
        const top = (startMinutesFromGridTop / ROW_MINUTES) * ROW_HEIGHT_PX;
        const height = Math.max(
          ROW_HEIGHT_PX - 2,
          (a.duration_minutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
        );
        const clientName = a.client?.name?.trim() || "Client";
        const serviceName = a.service?.name?.trim() || null;
        const twoLine = height >= TWO_LINE_THRESHOLD_PX;
        // Display-derived status (DB row unchanged). A past confirmed
        // appointment reads as "Done" (muted), a DB-completed row as
        // "Completed", a no-show as "No-show". Upcoming confirmed stays
        // full-strength with no tag. Cancelled is filtered out upstream.
        // Computed at render time; no timer.
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
            href={`/calendar/${a.id}`}
            style={{ top, height }}
            title={
              serviceName
                ? `${clientName} · ${serviceName} · ${localTime} · ${a.duration_minutes}m`
                : `${clientName} · ${localTime} · ${a.duration_minutes}m`
            }
            // Card color is service-based (Chloe feedback: "I want
            // different colors on the calendar for different
            // services"). Deterministic on service.id with name
            // fallback; palette excludes rose to keep allergy/EpiPen
            // red unique. softCardClasses still exists for any
            // future practitioner-color surface but is not used on
            // the per-appointment card any more.
            className={`absolute inset-x-1 z-10 overflow-hidden rounded-lg border-l-[3px] ${serviceCardClasses(a.service?.id ?? null, a.service?.name ?? null)} px-2 py-1 text-[11px] leading-tight shadow-sm transition hover:brightness-[0.97] dark:hover:brightness-110 ${terminal ? "opacity-60" : ""}`}
          >
            {twoLine ? (
              <>
                <div className="truncate font-semibold">{clientName}</div>
                <div className="truncate text-[10px] opacity-70">
                  {localTime}
                  {serviceName ? ` · ${serviceName}` : ""}
                  {` · ${a.duration_minutes}m`}
                  {statusTag ? ` · ${statusTag}` : ""}
                </div>
              </>
            ) : (
              <div className="truncate font-medium">
                {clientName}{" "}
                <span className="opacity-60">
                  · {localTime}
                  {statusTag ? ` · ${statusTag}` : ""}
                </span>
              </div>
            )}
          </Link>
        );
      })}

      <QuickBookDrawer
        open={draft !== null}
        draft={draft}
        clients={clients}
        services={services}
        studioTimezone={tz}
        onClose={() => setDraft(null)}
      />

      {/* PR #139. Drag chooser: when the practitioner drags a range
          we ask Book vs Block here before opening either drawer.
          Picking Book promotes the chooser draft to a QuickBookDraft;
          picking Block promotes it to a QuickBlockDraft. Cancel
          clears the chooser without opening anything. */}
      <DragActionChooser
        open={chooserDraft !== null}
        draft={
          chooserDraft != null
            ? {
                localDate: chooserDraft.date,
                startLocal: chooserDraft.startLocal,
                endLocal: chooserDraft.endLocal,
              }
            : null
        }
        onCancel={() => setChooserDraft(null)}
        onBook={() => {
          if (!chooserDraft) return;
          setDraft({
            localDate: chooserDraft.date,
            localTime: chooserDraft.startLocal,
            durationMinutes: chooserDraft.durationMinutes,
          });
          setChooserDraft(null);
        }}
        onBlock={() => {
          if (!chooserDraft) return;
          setBlockDraft({
            localDate: chooserDraft.date,
            startLocal: chooserDraft.startLocal,
            endLocal: chooserDraft.endLocal,
          });
          setChooserDraft(null);
        }}
      />

      <QuickBlockDrawer
        open={blockDraft !== null}
        draft={blockDraft}
        studioTimezone={tz}
        onClose={() => setBlockDraft(null)}
      />
    </div>
  );
}

// Local copy of the BlockoutCard from PR #10. Identical render
// behavior. Lives here because DayColumn now owns the column-level
// rendering — keeping the helper co-located avoids exporting an
// internal piece from page.tsx.
function BlockoutCard({
  label,
  title,
  startLocal,
  endLocal,
  durationMinutes,
  top,
  height,
}: {
  label: string;
  title: string;
  startLocal: string;
  endLocal: string;
  durationMinutes: number;
  top: number;
  height: number;
}) {
  const twoLine = height >= TWO_LINE_THRESHOLD_PX;
  return (
    // PR #138 Part 2. Per-block / recurring-break card. Replaces
    // the prior bg-neutral-100 + border-l-neutral-300 + text-neutral-600
    // (which sat too close to the empty grid gray) with a warm tan
    // wash + slate-warm border accent + a soft diagonal stripe so
    // blocks are unmistakably unavailable at a glance and remain
    // visually distinct from appointment cards. Text remains a
    // solid dark gray for legibility over the stripes.
    <div
      title={title}
      style={{
        top,
        height,
        backgroundColor: "#F4F1EA",
        backgroundImage:
          "repeating-linear-gradient(135deg, transparent 0, transparent 6px, rgba(140, 133, 121, 0.18) 6px, rgba(140, 133, 121, 0.18) 8px)",
      }}
      className="absolute inset-x-1 z-[5] overflow-hidden rounded-lg border border-[#C9C4B6] border-l-[3px] border-l-[#8C8579] px-2 py-1 text-[11px] leading-tight dark:border-stone-700 dark:border-l-stone-500 dark:bg-stone-800/80 dark:text-stone-200"
    >
      <div style={{ color: "#3F3F3F" }}>
        {twoLine ? (
          <>
            <div className="truncate font-medium">{label}</div>
            <div className="truncate text-[10px] opacity-80">
              {startLocal}–{endLocal} · {durationMinutes}m
            </div>
          </>
        ) : (
          <div className="truncate font-medium">
            {label} <span className="opacity-70">· {startLocal}–{endLocal}</span>
          </div>
        )}
      </div>
    </div>
  );
}

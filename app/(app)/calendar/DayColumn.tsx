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
import { useState } from "react";
import type { Service, StudioTimedBlock } from "@/lib/types/database";
import type {
  AppointmentWithPractitionerColor,
  RecurringBreakOccurrenceWithRule,
} from "@/lib/booking/queries";
import { localTimeString } from "@/lib/booking/tz";
import {
  QuickBookDrawer,
  type QuickBookClient,
  type QuickBookDraft,
} from "./QuickBookDrawer";
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

// Day-of-week labels + the "Mon · May 26" / "8 AM" formatters live in
// ./calendar-format (also a plain, non-"use client" module) for the same
// server/client-boundary reason. This client component doesn't need them.

// Soft (Fresha-style) appointment-card styling per practitioner color
// token. The shared resolvePractitionerColor() returns saturated
// bg-*-700 + white text used for small dots elsewhere; here on the
// calendar we want calm pastel cards with a colored left accent and dark
// readable text instead of intense solid blocks. Keyed by the same
// practitioner color tokens (lib/practitioner-colors.ts) so identity is
// preserved. Full literal class strings so Tailwind keeps them; falls
// back to neutral for any unknown token.
const SOFT_CARD_BY_TOKEN: Record<string, string> = {
  neutral:
    "bg-neutral-100 text-neutral-800 border-l-neutral-400 dark:bg-neutral-800/60 dark:text-neutral-100 dark:border-l-neutral-500",
  rose: "bg-rose-50 text-rose-900 border-l-rose-400 dark:bg-rose-950/40 dark:text-rose-100 dark:border-l-rose-500",
  amber:
    "bg-amber-50 text-amber-900 border-l-amber-400 dark:bg-amber-950/40 dark:text-amber-100 dark:border-l-amber-500",
  emerald:
    "bg-emerald-50 text-emerald-900 border-l-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-100 dark:border-l-emerald-500",
  teal: "bg-teal-50 text-teal-900 border-l-teal-400 dark:bg-teal-950/40 dark:text-teal-100 dark:border-l-teal-500",
  sky: "bg-sky-50 text-sky-900 border-l-sky-400 dark:bg-sky-950/40 dark:text-sky-100 dark:border-l-sky-500",
  indigo:
    "bg-indigo-50 text-indigo-900 border-l-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-100 dark:border-l-indigo-500",
  violet:
    "bg-violet-50 text-violet-900 border-l-violet-400 dark:bg-violet-950/40 dark:text-violet-100 dark:border-l-violet-500",
};

function softCardClasses(token: string | null | undefined): string {
  return SOFT_CARD_BY_TOKEN[token ?? "neutral"] ?? SOFT_CARD_BY_TOKEN.neutral;
}

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
// lib/booking/slots.ts). Phase A only displays this in the drawer;
// it isn't sent to any server action.
const CLICK_SNAP_MINUTES = 15;

function snapMinutes(n: number): number {
  return Math.floor(n / CLICK_SNAP_MINUTES) * CLICK_SNAP_MINUTES;
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

  function handleEmptyClick(e: React.MouseEvent<HTMLButtonElement>) {
    // Only fires on truly empty space. Appointment Links (z-10) and
    // blockout/break divs (z-[5]) intercept their own clicks because
    // they paint on top of this z-0 overlay; the overlay's onClick
    // never sees those events.
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    // Grid is 1 px = 1 min (ROW_HEIGHT_PX / ROW_MINUTES = 1).
    const minutesFromGridTop = Math.max(0, Math.min(VISIBLE_MINUTES - 1, y));
    const totalMinutes = HOUR_START * 60 + minutesFromGridTop;
    const snapped = snapMinutes(totalMinutes);
    if (snapped < HOUR_START * 60 || snapped >= HOUR_END * 60) return;
    setDraft({ localDate: date, localTime: minutesToHHMM(snapped) });
  }

  return (
    <div
      className="relative border-l border-neutral-100 dark:border-neutral-800/60"
      style={{ height: GRID_HEIGHT }}
    >
      {/* Today's column gets a faint cool (sky) wash, Google-style, so the
          current day is easy to spot at a glance and reads as distinct from
          the neutral-gray "unavailable" tint. Sits at the very bottom so the
          availability tint and events read on top. pointer-events-none —
          never blocks clicks; no ring / badge / extra height. */}
      {isToday && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 bg-sky-50/70 dark:bg-sky-950/25"
        />
      )}

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

      {/* Empty-cell click overlay. Sits at z-0 — beneath every
          event card so it ONLY captures clicks on transparent
          empty space. Renders an aria-labeled button rather than a
          div+onClick so keyboard users can focus and activate
          per-day cells; pressing Enter does the same thing as
          clicking at the top of the visible range (kept simple in
          Phase A — Phase B will replace this with a focused
          control). The button is invisible except for a subtle hover
          wash that signals the empty space is clickable. */}
      <button
        type="button"
        aria-label={`Open quick-book draft for ${date}`}
        onClick={handleEmptyClick}
        className="absolute inset-0 z-0 cursor-pointer rounded-none outline-none transition-colors hover:bg-sky-100/40 focus-visible:bg-sky-100/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-300 dark:hover:bg-sky-900/20 dark:focus-visible:bg-sky-900/20 dark:focus-visible:ring-sky-700"
      />

      {blocked && (
        <div className="absolute inset-0 z-[3] bg-neutral-50/80 dark:bg-neutral-900/40">
          <div className="px-2 pt-2 text-[11px] uppercase tracking-wider text-neutral-500">
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
        // Terminal (completed / no-show) appointments stay on the grid but
        // read as past: muted opacity + a short status tag. Cancelled ones
        // are filtered out upstream, so this only covers completed/no_show.
        const terminal = a.status !== "confirmed";
        const statusTag =
          a.status === "completed"
            ? "Done"
            : a.status === "no_show"
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
            className={`absolute inset-x-1 z-10 overflow-hidden rounded-lg border-l-[3px] ${softCardClasses(a.practitioner?.color)} px-2 py-1 text-[11px] leading-tight shadow-sm transition hover:brightness-[0.97] dark:hover:brightness-110 ${terminal ? "opacity-60" : ""}`}
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
        onClose={() => setDraft(null)}
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
    <div
      title={title}
      style={{ top, height }}
      className="absolute inset-x-1 z-[5] overflow-hidden rounded-lg border-l-[3px] border-l-neutral-300 bg-neutral-100 px-2 py-1 text-[11px] leading-tight text-neutral-600 dark:border-l-neutral-600 dark:bg-neutral-800/70 dark:text-neutral-300"
    >
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
  );
}

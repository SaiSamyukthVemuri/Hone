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
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import {
  QuickBookDrawer,
  type QuickBookClient,
  type QuickBookDraft,
} from "./QuickBookDrawer";

// Grid constants shared between the day column and the page-level
// hour rail. Kept here so both surfaces import a single source of
// truth.
export const HOUR_START = 8;
export const HOUR_END = 20;
export const ROW_HEIGHT_PX = 30; // 30 minutes per row → 1 px per minute
export const ROW_MINUTES = 30;
export const VISIBLE_MINUTES = (HOUR_END - HOUR_START) * 60;
export const GRID_HEIGHT = (VISIBLE_MINUTES / ROW_MINUTES) * ROW_HEIGHT_PX;
export const DAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

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
}: Props) {
  const [draft, setDraft] = useState<QuickBookDraft | null>(null);

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
      className="relative border-l border-neutral-200 dark:border-neutral-800"
      style={{ height: GRID_HEIGHT }}
    >
      {/* Half-hour grid lines (decorative). */}
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
              ? "border-neutral-200/60 dark:border-neutral-800/60"
              : "border-neutral-200 dark:border-neutral-800")
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
          control). The button is intentionally invisible. */}
      <button
        type="button"
        aria-label={`Open quick-book draft for ${date}`}
        onClick={handleEmptyClick}
        className="absolute inset-0 z-0 cursor-pointer rounded-none"
      />

      {blocked && (
        <div className="absolute inset-0 z-[3] bg-neutral-100/80 dark:bg-neutral-800/40">
          <div className="px-2 pt-2 text-[11px] uppercase tracking-wider text-neutral-500">
            Blocked
          </div>
        </div>
      )}

      {recurringBreaks.map((occ) => {
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
        const color = resolvePractitionerColor(a.practitioner?.color);
        const clientName = a.client?.name?.trim() || "Client";
        const serviceName = a.service?.name?.trim() || null;
        const twoLine = height >= TWO_LINE_THRESHOLD_PX;
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
            className={`absolute inset-x-1 z-10 overflow-hidden rounded-md ${color.bg} ${color.text} px-2 py-1 text-[11px] leading-tight hover:opacity-90`}
          >
            {twoLine ? (
              <>
                <div className="truncate font-medium">{clientName}</div>
                <div className="truncate text-[10px] opacity-80">
                  {localTime}
                  {serviceName ? ` · ${serviceName}` : ""}
                  {` · ${a.duration_minutes}m`}
                </div>
              </>
            ) : (
              <div className="truncate font-medium">
                {clientName}{" "}
                <span className="opacity-70">· {localTime}</span>
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
      className="absolute inset-x-1 z-[5] overflow-hidden rounded-md bg-neutral-200 px-2 py-1 text-[11px] leading-tight text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
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

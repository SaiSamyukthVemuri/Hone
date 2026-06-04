import type { SupabaseClient } from "@supabase/supabase-js";
import {
  localDayOfWeek,
  localMinutesSinceMidnight,
  localTimeString12h,
  minutesToHHMM,
  utcInstantFromLocal,
} from "./tz";

export type Slot = {
  start: string; // ISO UTC
  end: string; // ISO UTC
  // Client-facing 12-hour label (e.g. "9:00 AM"). Built with the
  // localTimeString12h formatter so public booking + reschedule slot
  // buttons read in the format clients expect. Internal practitioner
  // surfaces don't consume this field; they format their own labels
  // via localTimeString (24-hour) directly.
  startLabel: string;
};

// Public-only past-time guard for slot lists.
//
// Returns the subset of `slots` whose `start` instant is strictly
// after `now`. The shared helper exists so public booking, public
// reschedule, and the public next-available helpers cannot drift
// apart on what "future slot" means (PR #149 found that the
// reschedule slot list lacked this filter while public booking
// already had it).
//
// What this is NOT
// ----------------
// * NOT used by the practitioner calendar quick-book drawer or by
//   the internal slot helpers in app/(app)/calendar/actions.ts.
//   Practitioners intentionally see past slots for charting
//   workflows; only the PUBLIC surfaces (cancel/reschedule/book
//   tokenized + slug routes) apply this filter.
// * NOT a lead-time / buffer. A slot starting one minute from now
//   still passes. Add a separate helper if a real "n-hour lead time"
//   becomes a per-studio setting.
//
// `now` defaults to `new Date()` so callers don't need to plumb a
// clock; tests pass an explicit `now` so the filter is deterministic.
export function filterFutureSlots(
  slots: ReadonlyArray<Slot>,
  now: Date = new Date(),
): Slot[] {
  const nowMs = now.getTime();
  return slots.filter((s) => new Date(s.start).getTime() > nowMs);
}

type StudioRow = {
  id: string;
  timezone: string;
  default_appointment_duration_minutes: number;
  buffer_minutes: number;
};

type DefaultRow = {
  day_of_week: number;
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
};

type OverrideRow = {
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
};

// Migration 0030: slots now reads the unified shadow table
// studio_calendar_reservations, which holds protected intervals for
// confirmed appointments (with trailing buffer), one-off timed
// blocks, and full-day blockouts. Only the interval is selected;
// category labels and private notes never reach the public page.
type ReservationRow = {
  starts_at: string;
  ends_at: string;
};

type BlockoutRow = {
  starts_on: string;
  ends_on: string;
};

const SLOT_GRANULARITY_MINUTES = 15;

// Strips seconds from a "HH:MM:SS" coming back from a postgres time column.
function trimTime(t: string | null): string | null {
  if (!t) return null;
  return t.slice(0, 5);
}

export async function getAvailableSlots(
  supabase: SupabaseClient,
  studio: StudioRow,
  dateStr: string,
  serviceDurationMinutes?: number,
): Promise<Slot[]> {
  const tz = studio.timezone;
  const dow = localDayOfWeek(new Date(`${dateStr}T12:00:00Z`), tz);
  const buffer = Math.max(0, studio.buffer_minutes ?? 0);
  const duration =
    serviceDurationMinutes ?? studio.default_appointment_duration_minutes ?? 60;

  // Blockout?
  const { data: blockouts } = await supabase
    .from("studio_blockouts")
    .select("starts_on, ends_on")
    .eq("studio_id", studio.id)
    .lte("starts_on", dateStr)
    .gte("ends_on", dateStr);
  if (blockouts && (blockouts as BlockoutRow[]).length > 0) {
    return [];
  }

  // Determine open window: override wins over default.
  let openTime: string | null = null;
  let closeTime: string | null = null;
  let isOpen = false;

  const { data: overrideRows } = await supabase
    .from("studio_availability_overrides")
    .select("is_open, open_time, close_time")
    .eq("studio_id", studio.id)
    .eq("effective_date", dateStr)
    .maybeSingle();
  if (overrideRows) {
    const o = overrideRows as OverrideRow;
    isOpen = o.is_open;
    openTime = trimTime(o.open_time);
    closeTime = trimTime(o.close_time);
  } else {
    const { data: defaultRow } = await supabase
      .from("studio_availability_default")
      .select("is_open, open_time, close_time")
      .eq("studio_id", studio.id)
      .eq("day_of_week", dow)
      .maybeSingle();
    if (defaultRow) {
      const d = defaultRow as DefaultRow;
      isOpen = d.is_open;
      openTime = trimTime(d.open_time);
      closeTime = trimTime(d.close_time);
    }
  }

  if (!isOpen || !openTime || !closeTime) return [];

  // Load every reservation whose interval overlaps the day's
  // availability window. The shadow holds appointment protected
  // intervals, one-off timed blocks, and full-day blockouts as
  // concrete UTC ranges. Filtering only on starts_at would miss a
  // late previous-day reservation whose interval extends into the
  // day we are searching.
  const windowStartUtc = utcInstantFromLocal(dateStr, "00:00", tz);
  const windowEndUtc = new Date(windowStartUtc.getTime() + 36 * 3600 * 1000);
  const { data: reservations } = await supabase
    .from("studio_calendar_reservations")
    .select("starts_at, ends_at")
    .eq("studio_id", studio.id)
    .lt("starts_at", windowEndUtc.toISOString())
    .gt("ends_at", windowStartUtc.toISOString());

  // The reservation rows already encode every relevant buffer:
  //   - appointment rows: ends_at = blocked_ends_at (starts_at +
  //     snapshotted buffer at booking time, per migration 0029).
  //   - timed_block rows: raw (starts_at, ends_at). Blocks do not
  //     impose their own buffer.
  //   - full_day_blockout rows: raw local-midnight UTC range.
  // We MUST NOT widen these intervals again on the JS side. Doing
  // so would double-count the buffer (the bug from the first
  // migration 0029 attempt).
  const conflicts = ((reservations ?? []) as ReservationRow[]).map((r) => ({
    start: new Date(r.starts_at).getTime(),
    end: new Date(r.ends_at).getTime(),
  }));

  const openMin = localMinutesSinceMidnight(openTime);
  const closeMin = localMinutesSinceMidnight(closeTime);

  const slots: Slot[] = [];
  for (let m = openMin; m + duration <= closeMin; m += SLOT_GRANULARITY_MINUTES) {
    const startLabel = minutesToHHMM(m);
    const slotStart = utcInstantFromLocal(dateStr, startLabel, tz);
    const slotEnd = new Date(slotStart.getTime() + duration * 60_000);
    const slotStartMs = slotStart.getTime();
    // If this slot were booked now, its protected interval would be
    // [slotStart, slotEnd + currentBuffer). Match the DB exclusion
    // rule: candidate's protected interval must not overlap any
    // existing protected interval. Half-open touching is allowed.
    const slotProtectedEndMs = slotEnd.getTime() + buffer * 60_000;

    const overlap = conflicts.some(
      (c) => slotStartMs < c.end && slotProtectedEndMs > c.start,
    );
    if (overlap) continue;

    slots.push({
      start: slotStart.toISOString(),
      end: slotEnd.toISOString(),
      startLabel: localTimeString12h(slotStart, tz),
    });
  }

  return slots;
}

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
  source_kind?: string;
  source_id?: string;
};

// One optional, SERVER-CONTROLLED reservation exclusion. Used only by the
// authenticated practitioner move-slot path so an appointment being moved does not
// count its OWN shadow reservation as a conflict against its new candidate times.
// Public booking / public reschedule never pass this (see the move-slot server
// action, which derives the appointment id server-side). Every OTHER reservation —
// other appointments, timed blocks, recurring-break occurrences, full-day blockouts
// — remains a conflict.
export type ReservationExclusion = {
  sourceKind: "appointment";
  sourceId: string;
};

type BlockoutRow = {
  starts_on: string;
  ends_on: string;
};

// Smart/packed scheduling. Slots are no longer a fixed every-15-minute grid
// (which produced 10:00/10:15/10:30/… and arbitrary mid-day gaps). Instead
// candidate starts are ANCHORED to (1) the opening time and (2) immediately
// after each existing reservation's protected end, plus a COARSE fallback so a
// long empty stretch still offers a few choices instead of a single slot.
// FALLBACK_GRANULARITY_MINUTES is intentionally coarse (hourly) — it only
// fills empty windows; the precise anchors do the packing.
const FALLBACK_GRANULARITY_MINUTES = 60;

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
  excludeReservation?: ReservationExclusion,
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
    .select("starts_at, ends_at, source_kind, source_id")
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
  const conflicts = ((reservations ?? []) as ReservationRow[])
    // Exclude ONLY the exact own-reservation of the appointment being moved (the
    // (source_kind, source_id) pair is unique). Every other reservation stays a conflict.
    .filter(
      (r) =>
        !(
          excludeReservation !== undefined &&
          r.source_kind === excludeReservation.sourceKind &&
          r.source_id === excludeReservation.sourceId
        ),
    )
    .map((r) => ({
      start: new Date(r.starts_at).getTime(),
      end: new Date(r.ends_at).getTime(),
    }));

  const openMin = localMinutesSinceMidnight(openTime);
  const closeMin = localMinutesSinceMidnight(closeTime);

  const openStartMs = utcInstantFromLocal(dateStr, openTime, tz).getTime();
  const closeMs = utcInstantFromLocal(dateStr, closeTime, tz).getTime();
  const durationMs = duration * 60_000;
  const bufferMs = buffer * 60_000;

  // Candidate slot starts come from three sources (NOT "every 15 minutes"):
  const candidateMs = new Set<number>();

  // (1) the opening anchor + (3) a COARSE fallback grid from opening. Generated
  //     in LOCAL minutes and converted per-step via utcInstantFromLocal so DST
  //     is handled exactly like the old grid (the fallback step is hourly, so
  //     an empty day shows 10:00, 11:00, 12:00 … not 10:00/10:15/10:30/…).
  for (let m = openMin; m + duration <= closeMin; m += FALLBACK_GRANULARITY_MINUTES) {
    candidateMs.add(utcInstantFromLocal(dateStr, minutesToHHMM(m), tz).getTime());
  }

  // (2) immediately after each existing reservation's PROTECTED end. The
  //     reservation rows already bake in the relevant buffer (appointment
  //     ends_at = end + snapshotted buffer, migration 0029; blocks/blockouts
  //     are raw) — so the conflict's `end` IS the earliest legal next start.
  //     We must NOT add the buffer again here (the migration-0029 double-count
  //     bug). This is what packs a new client in right after the previous one.
  for (const c of conflicts) {
    candidateMs.add(c.end);
  }

  const slots: Slot[] = [];
  for (const slotStartMs of [...candidateMs].sort((a, b) => a - b)) {
    // Stay inside the open window and leave room for the full service duration
    // before close (the trailing buffer may extend past close, as before).
    if (slotStartMs < openStartMs) continue;
    if (slotStartMs + durationMs > closeMs) continue;

    // Same half-open overlap rule as the DB exclusion: the candidate's
    // protected interval [start, end + currentBuffer) must not overlap any
    // existing protected interval. Touching is allowed.
    const slotProtectedEndMs = slotStartMs + durationMs + bufferMs;
    const overlap = conflicts.some(
      (c) => slotStartMs < c.end && slotProtectedEndMs > c.start,
    );
    if (overlap) continue;

    const slotStart = new Date(slotStartMs);
    slots.push({
      start: slotStart.toISOString(),
      end: new Date(slotStartMs + durationMs).toISOString(),
      startLabel: localTimeString12h(slotStart, tz),
    });
  }

  return slots;
}

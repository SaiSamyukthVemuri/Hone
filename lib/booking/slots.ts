import type { SupabaseClient } from "@supabase/supabase-js";
import {
  localDayOfWeek,
  localMinutesSinceMidnight,
  localTimeString,
  minutesToHHMM,
  utcInstantFromLocal,
} from "./tz";

export type Slot = {
  start: string; // ISO UTC
  end: string; // ISO UTC
  startLabel: string; // local "HH:MM" in studio tz
};

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

type AppointmentRow = {
  starts_at: string;
  // Migration 0029: trailing-only buffered end stored on each row by
  // the snapshot_appointment_buffer trigger. We read this directly
  // instead of expanding starts_at/ends_at in JS so the UI conflict
  // rule matches the DB exclusion constraint exactly.
  blocked_ends_at: string;
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

  // Load every confirmed appointment whose protected interval
  // [starts_at, blocked_ends_at) overlaps the day's availability
  // window. Filtering only on starts_at would miss a late
  // previous-day appointment whose buffer extends into the day we
  // are searching, leaving its trailing buffer unenforced in the UI.
  const windowStartUtc = utcInstantFromLocal(dateStr, "00:00", tz);
  const windowEndUtc = new Date(windowStartUtc.getTime() + 36 * 3600 * 1000);
  const { data: appts } = await supabase
    .from("appointments")
    .select("starts_at, blocked_ends_at")
    .eq("studio_id", studio.id)
    .eq("status", "confirmed")
    .lt("starts_at", windowEndUtc.toISOString())
    .gt("blocked_ends_at", windowStartUtc.toISOString());

  // Each existing appointment occupies its protected interval
  // [starts_at, blocked_ends_at), where blocked_ends_at is
  // ends_at + the studio's buffer at booking time (snapshotted by
  // the DB trigger in migration 0029).
  const conflicts = ((appts ?? []) as AppointmentRow[]).map((a) => ({
    start: new Date(a.starts_at).getTime(),
    end: new Date(a.blocked_ends_at).getTime(),
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
      startLabel: localTimeString(slotStart, tz),
    });
  }

  return slots;
}

// PR #258: single source of truth for the appointment-reminder cron cadence
// and the 24h/2h reminder windows, shared by the cron route AND the invariant
// tests so the schedule and the windows can never silently drift apart.
//
// Reliability invariant: a reminder window W minutes wide, sampled by a cron
// firing every P minutes, is only missable when W < P (a closed window of
// width >= P always contains a point of a P-minute grid). We keep W >= P; for
// the tight 2h window W = 30 = 2 * CRON_INTERVAL_MINUTES, so a single skipped
// cron fire still leaves a grid point inside the window. The tests assert this
// covers every appointment minute offset for the 2h and 24h windows.
//
// SCHEDULING (PR #258): a 2-hours-before reminder needs SUB-DAILY checks. The
// production Vercel plan caps cron cadence at once-per-day, which rejected a
// `*/15` vercel.json cron, so the appointment-reminders route is fired by an
// EXTERNAL scheduler (cron-job.org) every CRON_INTERVAL_MINUTES, sending
// `Authorization: Bearer ${CRON_SECRET}` (validated by lib/cron/auth.ts). The
// daily, Hobby-allowed materialize-recurring-breaks cron DOES live in
// vercel.json. APPOINTMENT_REMINDER_CRON_SCHEDULE documents the required
// external cadence (and is the vercel.json value to use if the plan is later
// upgraded to Pro). The window/cadence invariant below holds regardless of
// which scheduler fires the route. No new dependency, no migration.

export type ReminderKind = "24h" | "2h";

// The cadence the appointment-reminders route MUST be fired at (external
// scheduler today; the vercel.json value if upgraded to a Pro plan).
export const APPOINTMENT_REMINDER_CRON_SCHEDULE = "*/15 * * * *";
// This one IS in vercel.json (daily is allowed on every Vercel plan).
export const MATERIALIZE_RECURRING_BREAKS_CRON_SCHEDULE = "0 8 * * *";

// The reminder cadence in minutes (derived from the schedule above) the 2h
// window must stay compatible with.
export const CRON_INTERVAL_MINUTES = 15;

// [start, end] minutes-from-now for each reminder pass (CLOSED interval; the
// route filters starts_at >= start AND <= end). 24h is deliberately wide (2h);
// the 2h window is 30 min = 2 * CRON_INTERVAL_MINUTES.
export const REMINDER_WINDOW_MINUTES: Record<
  ReminderKind,
  { start: number; end: number }
> = {
  "24h": { start: 23 * 60, end: 25 * 60 },
  "2h": { start: 105, end: 135 },
};

export function reminderWindowIso(
  kind: ReminderKind,
  nowMs: number,
): { startIso: string; endIso: string } {
  const w = REMINDER_WINDOW_MINUTES[kind];
  return {
    startIso: new Date(nowMs + w.start * 60_000).toISOString(),
    endIso: new Date(nowMs + w.end * 60_000).toISOString(),
  };
}

// Appointment minute-offsets (0..59) NOT caught by ANY cron fire (on a
// cronPeriodMin grid) within the closed window [windowStartMin, windowEndMin].
// Empty array = every appointment is eligible at least once before it starts.
// This is the schedule/window compatibility invariant the route depends on,
// and it is exactly what fails for hourly cron + a 30-minute window.
export function uncoveredOffsets(
  windowStartMin: number,
  windowEndMin: number,
  cronPeriodMin: number,
): number[] {
  const uncovered: number[] = [];
  const base = 100_000; // arbitrary anchor; only base+offset vs the grid matters
  for (let offset = 0; offset < 60; offset++) {
    const apptMinute = base + offset;
    let caught = false;
    // A cron fire f (a multiple of cronPeriodMin) catches the appointment iff
    // (apptMinute - f) is inside the window, i.e. f in [appt-end, appt-start].
    for (let f = apptMinute - windowEndMin; f <= apptMinute - windowStartMin; f++) {
      if (f >= 0 && f % cronPeriodMin === 0) {
        caught = true;
        break;
      }
    }
    if (!caught) uncovered.push(offset);
  }
  return uncovered;
}

export function windowCoversAllOffsets(
  kind: ReminderKind,
  cronPeriodMin: number,
): boolean {
  const w = REMINDER_WINDOW_MINUTES[kind];
  return uncoveredOffsets(w.start, w.end, cronPeriodMin).length === 0;
}

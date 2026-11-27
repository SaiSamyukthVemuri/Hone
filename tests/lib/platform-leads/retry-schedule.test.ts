import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { APPOINTMENT_REMINDER_CRON_SCHEDULE, CRON_INTERVAL_MINUTES } from "@/lib/cron/reminder-schedule";

// LEAD-ALERT-01 (Codex P2 4253278108): the COMPLETE retry schedule is reachable
// inside the 20-hour replay cutoff for a lead arriving at ANY minute of the day,
// with the recovery on the reminders trigger -- and NOT with the daily cron
// alone. Fake time; the schedule's numbers are read from 0213 itself, so the
// proof cannot drift from the database.

const SQL = readFileSync("supabase/migrations/0213_platform_lead_alerts.sql", "utf8");
const minutes = (lit: string) => {
  const [n, unit] = lit.split(" ");
  return Number(n) * (unit.startsWith("hour") ? 60 : 1);
};
const BACKOFF = [...SQL.matchAll(/when \d then interval '([^']+)'|else interval '([^']+)'/g)].map((m) => minutes(m[1] ?? m[2]));
const CUTOFF = minutes(SQL.match(/first_attempted_at > v_now - interval '([^']+)'/)![1]);
const MAX_ATTEMPTS = Number(SQL.match(/a\.attempt_count < (\d+)/)![1]);
const DAY = 24 * 60;
const DAILY_LEAD_CRON = 13 * 60; // vercel.json "0 13 * * *"

/**
 * Simulate one alert whose provider always fails: the first attempt is the
 * immediate post-save send; each retry is due `backoff` after the previous
 * attempt and happens at the first trigger tick at or after it, while still
 * inside the cutoff. Returns the attempt times (minutes after arrival).
 */
function simulate(arrival: number, ticks: (from: number) => number): number[] {
  const attempts = [0];
  while (attempts.length < MAX_ATTEMPTS) {
    const due = attempts[attempts.length - 1] + BACKOFF[Math.min(attempts.length - 1, BACKOFF.length - 1)];
    const at = ticks(arrival + due) - arrival;
    if (at >= CUTOFF) break;
    attempts.push(at);
  }
  return attempts;
}
const everyMinutes = (p: number) => (t: number) => Math.ceil(t / p) * p;
const dailyAt = (minuteOfDay: number) => (t: number) => {
  const base = Math.floor(t / DAY) * DAY + minuteOfDay;
  return base >= t ? base : base + DAY;
};
/** The reminders trigger plus the daily backstop: whichever comes first. */
const withBackstop = (p: number) => (t: number) => Math.min(everyMinutes(p)(t), dailyAt(DAILY_LEAD_CRON)(t));

describe("the schedule read from 0213", () => {
  it("is 2 min, 10 min, 1 h, 6 h, at most 5 attempts, within 20 hours of the first", () => {
    expect(BACKOFF).toEqual([2, 10, 60, 360]);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(CUTOFF).toBe(20 * 60);
  });
});

describe("every arrival minute of the day reaches all five attempts inside the cutoff", () => {
  it(`on the reminders trigger (${APPOINTMENT_REMINDER_CRON_SCHEDULE}, every ${CRON_INTERVAL_MINUTES} min)`, () => {
    for (let arrival = 0; arrival < DAY; arrival += 1) {
      const a = simulate(arrival, withBackstop(CRON_INTERVAL_MINUTES));
      expect(a.length, `arrival ${arrival}`).toBe(MAX_ATTEMPTS);
      expect(a[a.length - 1], `arrival ${arrival}`).toBeLessThan(CUTOFF);
    }
  });

  it("and even if that trigger only fired HOURLY", () => {
    for (let arrival = 0; arrival < DAY; arrival += 1) {
      const a = simulate(arrival, withBackstop(60));
      expect(a.length, `arrival ${arrival}`).toBe(MAX_ATTEMPTS);
      expect(a[a.length - 1]).toBeLessThan(CUTOFF);
    }
  });

  it("whereas the daily cron ALONE cannot: no arrival reaches five attempts, and many get no retry at all", () => {
    let noRetry = 0;
    for (let arrival = 0; arrival < DAY; arrival += 1) {
      const a = simulate(arrival, dailyAt(DAILY_LEAD_CRON));
      expect(a.length, `arrival ${arrival}`).toBeLessThan(MAX_ATTEMPTS);
      if (a.length === 1) noRetry += 1;
    }
    expect(noRetry).toBeGreaterThan(0);
  });
});

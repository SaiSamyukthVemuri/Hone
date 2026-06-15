import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_REMINDER_CRON_SCHEDULE,
  CRON_INTERVAL_MINUTES,
  MATERIALIZE_RECURRING_BREAKS_CRON_SCHEDULE,
  REMINDER_WINDOW_MINUTES,
  reminderWindowIso,
  uncoveredOffsets,
  windowCoversAllOffsets,
} from "@/lib/cron/reminder-schedule";

// PR #258: schedule/window compatibility invariant. The deterministic model
// here is the single source of truth shared with the route + vercel.json: a
// reminder window W wide, sampled every P minutes, is missable iff W < P.

describe("2h reminder window coverage under the configured cadence", () => {
  it("the configured */15 cadence covers EVERY appointment minute offset (0-59)", () => {
    expect(uncoveredOffsets(105, 135, CRON_INTERVAL_MINUTES)).toEqual([]);
    expect(windowCoversAllOffsets("2h", CRON_INTERVAL_MINUTES)).toBe(true);
  });

  it("the OLD hourly cadence + 30-minute 2h window MISSES offsets (the reported bug)", () => {
    const missed = uncoveredOffsets(105, 135, 60);
    expect(missed.length).toBeGreaterThan(0);
    expect(windowCoversAllOffsets("2h", 60)).toBe(false);
  });

  it("the 2h window is wide enough to survive a single skipped cron fire", () => {
    const w = REMINDER_WINDOW_MINUTES["2h"];
    // 30 min = 2 * 15 -> at least 2 grid points in the closed window, so one
    // skipped fire still leaves one in-window.
    expect(w.end - w.start).toBe(2 * CRON_INTERVAL_MINUTES);
  });
});

describe("24h reminder window coverage stays safe", () => {
  it("covers every offset under */15 (and even under hourly)", () => {
    expect(windowCoversAllOffsets("24h", CRON_INTERVAL_MINUTES)).toBe(true);
    expect(windowCoversAllOffsets("24h", 60)).toBe(true);
  });
});

describe("schedule constants + window math", () => {
  it("the reminder cron schedule is */15 and the interval is 15", () => {
    expect(APPOINTMENT_REMINDER_CRON_SCHEDULE).toBe("*/15 * * * *");
    expect(CRON_INTERVAL_MINUTES).toBe(15);
  });

  it("the recurring-breaks cron schedule is daily", () => {
    expect(MATERIALIZE_RECURRING_BREAKS_CRON_SCHEDULE).toBe("0 8 * * *");
  });

  it("reminderWindowIso returns start/end offsets from now", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const w2 = reminderWindowIso("2h", now);
    expect(new Date(w2.startIso).getTime()).toBe(now + 105 * 60_000);
    expect(new Date(w2.endIso).getTime()).toBe(now + 135 * 60_000);
    const w24 = reminderWindowIso("24h", now);
    expect(new Date(w24.startIso).getTime()).toBe(now + 23 * 60 * 60_000);
    expect(new Date(w24.endIso).getTime()).toBe(now + 25 * 60 * 60_000);
  });
});

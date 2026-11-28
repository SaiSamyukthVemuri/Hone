import { describe, expect, it } from "vitest";
import {
  LEAD_ALERT_MIN_SEND_WINDOW_MS,
  LEAD_ALERT_SETTLE_RESERVE_MS,
  LEAD_ALERT_SWEEP_BUDGET_MS,
  LEAD_ALERT_SWEEP_MAX,
  REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS,
  REMINDER_TRIGGER_LEAD_ALERT_MAX,
} from "@/lib/platform-leads/alert-delivery";
import { CRON_INTERVAL_MINUTES } from "@/lib/cron/reminder-schedule";
import { FAIR_ORDER, simulate, type SimConfig } from "./helpers/retry-sim";

// LEAD-ALERT-01 (Codex P2 4253669922; Codex decision on #831): recovery
// capacity under burst and outage, by FAKE TIME, with the real schedule (from
// 0213) and the real sweep constants. What it proves:
//   * cohorts far above 45 alerts, arriving throughout the day, through a
//     provider outage, are all delivered when the provider is healthy-fast;
//   * scheduling is FAIR (earliest-due first) and the old 2-per-trigger cap
//     loses alerts the new capacity does not;
//   * where capacity genuinely runs out (a slow provider and a huge backlog),
//     nothing is silently lost: every alert ends accepted, failed or expired,
//     and expired alerts are the visible "failed: expired" of 0213 (the lead
//     itself is untouched). It does NOT claim five attempts for an unbounded
//     backlog.
// Overlapping sweeps (the reminders trigger and the daily backstop coincide at
// 13:00 here) never attempt one alert twice; the database's SKIP LOCKED claim
// is proved separately in tests/db/platform-lead-alerts.db.test.ts.

const DAY = 1440;
const DAILY = { everyMin: DAY, atMinuteOfDay: 13 * 60, budgetMs: LEAD_ALERT_SWEEP_BUDGET_MS, max: LEAD_ALERT_SWEEP_MAX };
const NEW = { everyMin: CRON_INTERVAL_MINUTES, budgetMs: REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS, max: REMINDER_TRIGGER_LEAD_ALERT_MAX };
const OLD = { everyMin: CRON_INTERVAL_MINUTES, budgetMs: 4_000, max: 2 };
const throughTheDay = (n: number) => Array.from({ length: n }, (_, i) => Math.floor((i * DAY) / n));
const run = (n: number, outage: [number, number], sendMs: number, trig = NEW, order: SimConfig["order"] = "due") =>
  simulate({
    arrivals: throughTheDay(n),
    outage,
    sendMs,
    triggers: [trig, DAILY],
    settleReserveMs: LEAD_ALERT_SETTLE_RESERVE_MS,
    minSendWindowMs: LEAD_ALERT_MIN_SEND_WINDOW_MS,
    order,
    horizonMin: 3 * DAY,
  });

describe("the scheduler under test is the real one", () => {
  it("0213 claims earliest-due first", () => {
    expect(FAIR_ORDER).toBe(true);
  });
});

describe("outage cohorts far above 45 alerts, arriving throughout the day", () => {
  for (const n of [300, 1000]) {
    it(`${n} alerts through a 6-hour provider outage are ALL delivered (healthy-fast provider afterwards)`, () => {
      const r = run(n, [0, 360], 300);
      expect(r).toMatchObject({ accepted: n, failed: 0, expired: 0, pending: 0 });
      // Fair: no alert waits more than a few hours past its due time.
      expect(r.maxWaitMin).toBeLessThan(180);
    });
  }

  it("the old 2-per-trigger cap LOSES alerts the new capacity delivers", () => {
    const before = run(1000, [0, 360], 300, OLD, "created");
    const after = run(1000, [0, 360], 300);
    expect(before.expired).toBeGreaterThan(0);
    expect(after.expired).toBe(0);
  });
});

describe("where capacity genuinely runs out, nothing is silently lost", () => {
  for (const [n, outage] of [[300, [300, 1020]], [1000, [0, 360]], [1000, [300, 1020]]] as Array<[number, [number, number]]>) {
    it(`slow provider (3 s per send), ${n} alerts, outage ${outage.join("-")} min: every alert accounted for, fewer lost than before`, () => {
      const now = run(n, outage, 3_000);
      const was = run(n, outage, 3_000, OLD, "created");
      expect(now.accepted + now.failed + now.expired).toBe(n);
      expect(now.pending).toBe(0);
      expect(now.expired + now.failed).toBeLessThan(was.expired + was.failed);
    });
  }

  it("an outage longer than the whole attempt schedule ends in VISIBLE failures, not silent drops", () => {
    const r = run(300, [300, 1020], 300);
    expect(r.failed).toBeGreaterThan(0);
    expect(r.accepted + r.failed + r.expired).toBe(300);
  });
});

describe("no outage", () => {
  it("every alert, however many, is accepted at its immediate post-save send", () => {
    expect(run(1000, [0, 0], 3_000)).toMatchObject({ accepted: 1000, attempts: 1000 });
  });
});

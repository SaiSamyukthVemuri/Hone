import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIGNAL_REFRESH_MIN_GAP_MS } from "@/lib/calendar/refresh-policy";
import { SIGNAL_COALESCE_MS, createScheduleSignalController, type SignalGuards } from "@/lib/calendar/schedule-signal";

// Insurance PEER-0271-FINAL-DELTA-2 G1: a signal that arrives while the previous refresh is still
// rendering must not start an overlapping refresh and must not be lost: the view is stale again,
// so exactly ONE refresh follows once the current one completes. A fake clock stands in for time;
// the fake refresh takes REFRESH_MS to render, like a slow server component render.

const REFRESH_MS = 800;

function slowHarness(start = 1_000_000) {
  let now = start;
  let last = start - 10_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const guards: SignalGuards = { visible: true, online: true, dialogOpen: false, editing: false };
  let inFlight = false;
  let doneAt = 0;
  let started = 0;
  let maxConcurrent = 0;
  let concurrent = 0;
  const startTimes: number[] = [];
  const controller = createScheduleSignalController({
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    guards: () => ({ ...guards }),
    lastRefreshMs: () => last,
    busy: () => inFlight,
    refresh: () => {
      started++;
      startTimes.push(now);
      last = now;
      controller.markRefresh();
      inFlight = true;
      doneAt = now + REFRESH_MS;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const nextTimer = timers.length ? Math.min(...timers.map((t) => t.at)) : Infinity;
      const nextDone = inFlight ? doneAt : Infinity;
      const at = Math.min(nextTimer, nextDone);
      if (at > end) break;
      now = Math.max(now, at);
      if (inFlight && doneAt <= now) {
        inFlight = false;
        concurrent--;
        controller.refreshSettled(); // what the component's isPending effect does
        continue;
      }
      const i = timers.findIndex((t) => t.at === at);
      const [t] = timers.splice(i, 1);
      t.fn();
    }
    now = end;
  };
  return { controller, advance, guards, get started() { return started; }, get maxConcurrent() { return maxConcurrent; }, startTimes, get inFlight() { return inFlight; } };
}

describe("a signal during a pending refresh (G1)", () => {
  it("is held, never overlapped, and yields exactly one refresh after the current one completes", () => {
    const h = slowHarness();
    h.controller.signal();
    h.advance(SIGNAL_COALESCE_MS);
    expect(h.started).toBe(1);
    expect(h.inFlight).toBe(true);

    // Three signals land while the 800 ms refresh is rendering (well past the 250 ms gap).
    h.advance(300);
    h.controller.signal();
    h.advance(200);
    h.controller.signal();
    h.advance(100);
    h.controller.signal();
    expect(h.started).toBe(1);
    expect(h.controller.isPending()).toBe(true);

    h.advance(5_000);
    expect(h.started).toBe(2); // exactly one follow-up, not three
    expect(h.maxConcurrent).toBe(1); // never overlapped
    expect(h.controller.isPending()).toBe(false); // no lost signal, none left over
    // The follow-up began only after the first finished rendering.
    expect(h.startTimes[1] - h.startTimes[0]).toBeGreaterThanOrEqual(REFRESH_MS);
  });

  it("keeps the 250 ms minimum gap when the refresh finishes fast", () => {
    const h = slowHarness();
    h.controller.signal();
    h.advance(SIGNAL_COALESCE_MS);
    h.controller.signal(); // arrives mid-refresh
    h.advance(5_000);
    expect(h.started).toBe(2);
    expect(h.startTimes[1] - h.startTimes[0]).toBeGreaterThanOrEqual(SIGNAL_REFRESH_MIN_GAP_MS);
  });

  it("a held signal still honours the four guards after the refresh completes", () => {
    for (const held of [{ visible: false }, { online: false }, { dialogOpen: true }, { editing: true }] as const) {
      const h = slowHarness();
      h.controller.signal();
      h.advance(SIGNAL_COALESCE_MS);
      h.controller.signal();
      Object.assign(h.guards, held);
      h.advance(5_000);
      expect(h.started).toBe(1);
      expect(h.controller.isPending()).toBe(true);
    }
  });

  it("a signal with nothing in flight is unchanged: one refresh", () => {
    const h = slowHarness();
    h.controller.signal();
    h.advance(5_000);
    expect(h.started).toBe(1);
    expect(h.controller.isPending()).toBe(false);
  });

  it("a long stream of signals during slow refreshes never overlaps and stays bounded", () => {
    const h = slowHarness();
    for (let t = 0; t < 10_000; t += 50) {
      h.controller.signal();
      h.advance(50);
    }
    h.advance(5_000);
    expect(h.maxConcurrent).toBe(1);
    expect(h.started).toBeLessThanOrEqual(Math.ceil(10_000 / REFRESH_MS) + 2);
    expect(h.controller.isPending()).toBe(false);
  });
});

describe("the component wiring", () => {
  const component = readFileSync("app/(app)/calendar/CalendarAutoRefresh.tsx", "utf8");

  it("holds signals while its transition is pending, hands the settle to the controller, and bounds a stuck one", () => {
    expect(component).toMatch(/busy: \(\) => inFlightSinceMs\.current !== null && Date\.now\(\) - inFlightSinceMs\.current < REFRESH_IN_FLIGHT_MAX_MS/);
    expect(component).toMatch(/controllerRef\.current\?\.refreshSettled\(\)/);
    expect(component).toMatch(/inFlightSinceMs\.current = null/);
    expect(component).toMatch(/REFRESH_IN_FLIGHT_MAX_MS = 30_000/);
  });
});

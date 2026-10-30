import { describe, expect, it } from "vitest";
import { SIGNAL_REFRESH_MIN_GAP_MS } from "@/lib/calendar/refresh-policy";
import {
  PENDING_RECHECK_MS,
  RESUME_CATCHUP_AFTER_MS,
  SIGNAL_COALESCE_MS,
  createScheduleSignalController,
  isUnannouncedFind,
  scheduleSignalEnabled,
  rejoinDelayMs,
  REJOIN_MAX_ATTEMPTS,
  scheduleSignalTopic,
  type SignalGuards,
} from "@/lib/calendar/schedule-signal";
import { scheduleFingerprint } from "@/lib/calendar/schedule-fingerprint";

// HON-48 Q7: the whole client-side decision, proved without a browser. A fake clock
// and a fake timer queue stand in for the DOM; the guards are a plain object.

const STUDIO = "5b0a3f1e-2c4d-4e6f-8a9b-0c1d2e3f4a5b";

function harness(start = 1_000_000) {
  let now = start;
  let last = start;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const guards: SignalGuards = { visible: true, online: true, dialogOpen: false, editing: false };
  let refreshes = 0;
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
    refresh: () => {
      refreshes++;
      last = now;
      controller.markRefresh();
    },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.fn();
    }
    now = end;
  };
  return { controller, guards, advance, refreshes: () => refreshes, timers: () => timers.length, setLast: (v: number) => (last = v), now: () => now };
}

describe("topic and switch", () => {
  it("names only a lower-case uuid; anything else yields no topic", () => {
    expect(scheduleSignalTopic(STUDIO)).toBe(`schedule:${STUDIO}`);
    for (const bad of [undefined, null, "", "not-a-uuid", STUDIO.toUpperCase(), `${STUDIO}x`, ` ${STUDIO}`, "schedule:" + STUDIO]) {
      expect(scheduleSignalTopic(bad as string | undefined)).toBeNull();
    }
  });
  it("is on unless explicitly switched off", () => {
    // Ships dark: only "on" enables it.
    expect(scheduleSignalEnabled(undefined)).toBe(false);
    expect(scheduleSignalEnabled("")).toBe(false);
    expect(scheduleSignalEnabled("off")).toBe(false);
    expect(scheduleSignalEnabled("true")).toBe(false);
    expect(scheduleSignalEnabled("on")).toBe(true);
  });
});

describe("a signal sets a flag; the guards decide when", () => {
  it("one signal on an idle screen refreshes once after the coalescing window", () => {
    const h = harness();
    h.setLast(h.now() - 60_000);
    h.controller.signal();
    expect(h.refreshes()).toBe(0);
    h.advance(SIGNAL_COALESCE_MS);
    expect(h.refreshes()).toBe(1);
    expect(h.controller.isPending()).toBe(false);
  });

  it("a burst of signals inside the window is one refresh", () => {
    const h = harness();
    h.setLast(h.now() - 60_000);
    for (let i = 0; i < 25; i++) {
      h.controller.signal();
      h.advance(5);
    }
    h.advance(2_000);
    expect(h.refreshes()).toBe(1);
  });

  it("a long stream of signals never refreshes more often than the minimum gap (no storm)", () => {
    const h = harness();
    h.setLast(h.now() - 60_000);
    const start = h.now();
    for (let t = 0; t < 30_000; t += 40) {
      h.controller.signal();
      h.advance(40);
    }
    h.advance(2_000);
    const elapsed = h.now() - start;
    expect(h.refreshes()).toBeLessThanOrEqual(Math.ceil(elapsed / SIGNAL_REFRESH_MIN_GAP_MS));
    expect(h.refreshes()).toBeGreaterThan(5);
  });

  it.each([
    ["a drawer is open", { dialogOpen: true }],
    ["a field is focused", { editing: true }],
  ])("held while %s, then fires once the screen is idle again", (_l, over) => {
    const h = harness();
    h.setLast(h.now() - 60_000);
    Object.assign(h.guards, over);
    h.controller.signal();
    h.advance(10_000);
    expect(h.refreshes()).toBe(0);
    expect(h.controller.isPending()).toBe(true);
    for (const k of Object.keys(over)) (h.guards as unknown as Record<string, boolean>)[k] = false;
    h.advance(PENDING_RECHECK_MS);
    expect(h.refreshes()).toBe(1);
  });

  it("a hidden tab holds the refresh without polling; becoming visible runs it once", () => {
    const h = harness();
    h.setLast(h.now() - 60_000);
    h.guards.visible = false;
    h.controller.signal();
    h.advance(30_000);
    expect(h.refreshes()).toBe(0);
    expect(h.timers()).toBe(0); // nothing is spinning while hidden
    h.guards.visible = true;
    h.controller.resume(30_000);
    expect(h.refreshes()).toBe(1);
  });

  it("the screen's own refresh just before a signal folds the echo into the gap, then one more refresh", () => {
    const h = harness();
    h.setLast(h.now() - 10); // this screen refreshed 10 ms ago (its own write)
    h.controller.signal();
    h.advance(SIGNAL_COALESCE_MS);
    expect(h.refreshes()).toBe(0); // inside the minimum gap
    h.advance(SIGNAL_REFRESH_MIN_GAP_MS);
    expect(h.refreshes()).toBe(1);
  });

  it("a signal that lands while a refresh is already done is not lost", () => {
    const h = harness();
    h.setLast(h.now() - 60_000);
    h.controller.signal();
    h.advance(SIGNAL_COALESCE_MS);
    expect(h.refreshes()).toBe(1);
    h.advance(100);
    h.controller.signal(); // a second change moments after the refresh read the data
    h.advance(SIGNAL_REFRESH_MIN_GAP_MS + SIGNAL_COALESCE_MS);
    expect(h.refreshes()).toBe(2);
  });

  it("dispose cancels everything: nothing fires afterwards", () => {
    const h = harness();
    h.setLast(h.now() - 60_000);
    h.controller.signal();
    h.controller.dispose();
    h.advance(10_000);
    h.controller.signal();
    h.controller.status("SUBSCRIBED");
    h.advance(10_000);
    expect(h.refreshes()).toBe(0);
    expect(h.timers()).toBe(0);
  });
});

describe("a lost signal still converges: every join is a catch-up", () => {
  it("the FIRST join refreshes once (a change can land between the render and the join)", () => {
    const h = harness();
    h.advance(2_000); // page has been up for 2 s
    h.controller.status("SUBSCRIBED");
    h.advance(SIGNAL_COALESCE_MS);
    expect(h.refreshes()).toBe(1);
  });

  it("a socket drop then a re-join is exactly one extra refresh, however many statuses flap", () => {
    const h = harness();
    h.advance(2_000);
    h.controller.status("SUBSCRIBED");
    h.advance(1_000);
    expect(h.refreshes()).toBe(1);
    for (const s of ["CLOSED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) h.controller.status(s);
    h.advance(30_000);
    expect(h.refreshes()).toBe(1); // going down refreshes nothing
    h.controller.status("SUBSCRIBED");
    h.advance(5_000);
    expect(h.refreshes()).toBe(2);
  });

  it("a token refresh (setAuth) sends no status and no refresh", () => {
    const h = harness();
    h.advance(2_000);
    h.controller.status("SUBSCRIBED");
    h.advance(1_000);
    const before = h.refreshes();
    h.advance(3_600_000);
    expect(h.refreshes()).toBe(before);
  });

  it("a rejoin while a drawer is open waits, then refreshes once", () => {
    const h = harness();
    h.advance(2_000);
    h.controller.status("SUBSCRIBED");
    h.advance(1_000);
    h.guards.dialogOpen = true;
    h.controller.status("SUBSCRIBED");
    h.advance(20_000);
    expect(h.refreshes()).toBe(1);
    h.guards.dialogOpen = false;
    h.advance(PENDING_RECHECK_MS);
    expect(h.refreshes()).toBe(2);
  });
});

describe("a tab or screen that slept (hidden, offline) catches up when it returns", () => {
  it("a long hide is a catch-up even though no signal and no status was ever delivered", () => {
    const h = harness();
    h.advance(2_000);
    h.controller.status("SUBSCRIBED");
    h.advance(1_000);
    expect(h.refreshes()).toBe(1);
    h.guards.visible = false;
    h.advance(60_000); // the socket may have been put to sleep and missed messages
    h.guards.visible = true;
    h.controller.resume(60_000);
    expect(h.refreshes()).toBe(2);
  });

  it("a short alt-tab is not a catch-up", () => {
    const h = harness();
    h.advance(2_000);
    h.controller.status("SUBSCRIBED");
    h.advance(1_000);
    h.advance(5_000);
    h.controller.resume(RESUME_CATCHUP_AFTER_MS - 1);
    expect(h.refreshes()).toBe(1);
  });

  it("coming back online is always a catch-up", () => {
    const h = harness();
    h.advance(2_000);
    h.controller.status("SUBSCRIBED");
    h.advance(1_000);
    h.advance(10_000);
    h.controller.resume(Number.POSITIVE_INFINITY);
    expect(h.refreshes()).toBe(2);
  });
});

describe("degraded detection: the fallback found a change no signal announced", () => {
  it("markRefresh reports whether a signal was heard since the previous mark", () => {
    const h = harness();
    expect(h.controller.markRefresh()).toBe(false);
    h.controller.signal();
    expect(h.controller.markRefresh()).toBe(true);
    expect(h.controller.markRefresh()).toBe(false);
  });

  it("a catch-up join is not an announcement", () => {
    const h = harness();
    h.controller.status("SUBSCRIBED");
    expect(h.controller.markRefresh()).toBe(false);
  });

  it.each([
    ["interval", false, true, true],
    ["focus", false, true, true],
    ["interval", true, true, false], // a signal announced it
    ["interval", false, false, false], // nothing changed
    ["signal", false, true, false], // a signal-driven refresh is the normal path
    [null, false, true, false], // the screen's own write
  ] as const)("cause %s, announced %s, changed %s -> %s", (cause, announced, changed, expected) => {
    expect(isUnannouncedFind({ cause, announced, fingerprintChanged: changed })).toBe(expected);
  });
});

describe("the schedule fingerprint", () => {
  const a = { id: "a1", practitioner_id: "p", client_id: "c", service_id: "s", starts_at: "2026-11-02T17:00:00Z", ends_at: "2026-11-02T18:00:00Z", status: "confirmed" };
  it("is stable, order-independent, and moves with every schedule-visible field", () => {
    const base = scheduleFingerprint({ appointments: [a, { ...a, id: "a2" }] });
    expect(scheduleFingerprint({ appointments: [{ ...a, id: "a2" }, a] })).toBe(base);
    for (const change of [{ status: "cancelled" }, { starts_at: "2026-11-02T17:30:00Z" }, { practitioner_id: "q" }, { ends_at: "2026-11-02T18:30:00Z" }]) {
      expect(scheduleFingerprint({ appointments: [{ ...a, ...change }, { ...a, id: "a2" }] })).not.toBe(base);
    }
    expect(scheduleFingerprint({ appointments: [a] })).not.toBe(base); // a deleted row
  });
  it("ignores bookkeeping fields and covers blocks, blockouts and breaks", () => {
    const base = scheduleFingerprint({ appointments: [a] });
    expect(scheduleFingerprint({ appointments: [{ ...a, confirmation_sent_at: "x", reminder_24h_send_attempts: 3 }] })).toBe(base);
    expect(scheduleFingerprint({ appointments: [a], timedBlocks: [{ id: "b", starts_at: "x", ends_at: "y", category: "lunch" }] })).not.toBe(base);
    expect(scheduleFingerprint({ appointments: [a], blockouts: [{ id: "o", starts_on: "2026-11-03", ends_on: "2026-11-03" }] })).not.toBe(base);
    expect(scheduleFingerprint({ appointments: [a], recurringOccurrences: [{ id: "r", starts_at: "x", ends_at: "y" }] })).not.toBe(base);
  });
  it("contains no row content (a short hex digest)", () => {
    expect(scheduleFingerprint({ appointments: [a] })).toMatch(/^[0-9a-f]{8}$/);
  });
});


describe("a refused or queued join backs off with jitter and then stops", () => {
  it("is bounded, grows, and is spread across the equal-jitter window", () => {
    for (let a = 0; a < REJOIN_MAX_ATTEMPTS; a++) {
      const lo = rejoinDelayMs(a, () => 0);
      const hi = rejoinDelayMs(a, () => 1);
      const ceiling = Math.min(60_000, 2_000 * 2 ** a);
      expect(lo).toBe(Math.round(ceiling / 2));
      expect(hi).toBe(ceiling);
      expect(rejoinDelayMs(a, () => 0.5)).toBeGreaterThan(lo - 1);
    }
    expect(rejoinDelayMs(0, () => 0)).toBeGreaterThanOrEqual(1_000);
    expect(rejoinDelayMs(99, () => 1)).toBe(60_000);
    expect(REJOIN_MAX_ATTEMPTS).toBeLessThanOrEqual(8);
  });
  it("two clients that fail together do not retry together", () => {
    const a = rejoinDelayMs(2, () => 0.1);
    const b = rejoinDelayMs(2, () => 0.9);
    expect(Math.abs(a - b)).toBeGreaterThan(2_000);
  });
});

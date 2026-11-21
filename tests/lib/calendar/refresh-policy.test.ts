import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTO_REFRESH_INTERVAL_MS,
  FOCUS_REFRESH_MIN_GAP_MS,
  shouldAutoRefresh,
  type AutoRefreshInputs,
} from "@/lib/calendar/refresh-policy";

// HON-48: the other four people on the calendar must see a committed change
// without reloading, but a refresh must never land while someone is working.

const IDLE: AutoRefreshInputs = {
  trigger: "interval",
  visible: true,
  online: true,
  dialogOpen: false,
  editing: false,
  nowMs: 1_000_000,
  lastRefreshMs: 1_000_000 - AUTO_REFRESH_INTERVAL_MS,
};
const at = (over: Partial<AutoRefreshInputs>) => shouldAutoRefresh({ ...IDLE, ...over });

describe("the interval trigger", () => {
  it("refreshes a visible, idle, online screen once a full interval has passed", () => {
    expect(at({})).toBe(true);
    expect(at({ lastRefreshMs: IDLE.nowMs - AUTO_REFRESH_INTERVAL_MS - 1 })).toBe(true);
  });

  it("does not refresh a moment early", () => {
    expect(at({ lastRefreshMs: IDLE.nowMs - AUTO_REFRESH_INTERVAL_MS + 1 })).toBe(false);
    expect(at({ lastRefreshMs: IDLE.nowMs })).toBe(false);
  });
});

describe("the focus trigger (coming back to the tab)", () => {
  it("asks sooner than the interval, but not more often than the minimum gap", () => {
    expect(at({ trigger: "focus", lastRefreshMs: IDLE.nowMs - FOCUS_REFRESH_MIN_GAP_MS })).toBe(true);
    expect(at({ trigger: "focus", lastRefreshMs: IDLE.nowMs - FOCUS_REFRESH_MIN_GAP_MS + 1 })).toBe(false);
    expect(FOCUS_REFRESH_MIN_GAP_MS).toBeLessThan(AUTO_REFRESH_INTERVAL_MS);
  });
});

describe("never while someone is working or nothing could be fetched", () => {
  it.each([
    ["the tab is hidden", { visible: false }],
    ["the browser is offline", { online: false }],
    ["a drawer or dialog is open (new appointment, move, block edit)", { dialogOpen: true }],
    ["a field is focused", { editing: true }],
  ])("%s", (_label, over) => {
    for (const trigger of ["interval", "focus"] as const) {
      expect(at({ ...over, trigger, lastRefreshMs: 0 })).toBe(false);
    }
  });

  it("a clock that went backwards or is not a number never refreshes", () => {
    expect(at({ lastRefreshMs: IDLE.nowMs + 5_000 })).toBe(false);
    expect(at({ nowMs: Number.NaN })).toBe(false);
  });

  it("a refresh held off by an open drawer happens as soon as it closes (the gap kept growing)", () => {
    const heldOff = at({ dialogOpen: true, lastRefreshMs: IDLE.nowMs - 5 * AUTO_REFRESH_INTERVAL_MS });
    const afterClose = at({ dialogOpen: false, lastRefreshMs: IDLE.nowMs - 5 * AUTO_REFRESH_INTERVAL_MS });
    expect([heldOff, afterClose]).toEqual([false, true]);
  });
});

describe("the component and where it is mounted", () => {
  const component = readFileSync("app/(app)/calendar/CalendarAutoRefresh.tsx", "utf8");
  const toolbar = readFileSync("app/(app)/calendar/CalendarToolbar.tsx", "utf8");

  it("only asks the existing server render for a refresh: no socket, no subscription, one probe request", () => {
    expect(component).toMatch(/router\.refresh\(\)/);
    // No realtime platform, ever (Sam's HON-48 bound): no socket, no event stream, no Supabase client, no channel.
    expect(component).not.toMatch(/WebSocket|EventSource|supabase|realtime|channel\(/i);
    // The one network call is the change probe: a plain GET to the one route that answers with a hash, never cached,
    // never following a redirect (a redirect is an authorization answer and stops the polling).
    expect([...component.matchAll(/fetch\(/g)]).toHaveLength(1);
    expect(component).toMatch(/\/api\/calendar\/change-fingerprint\?view=/);
    expect(component).toMatch(/cache: "no-store"/);
    expect(component).toMatch(/redirect: "manual"/);
    expect(component).not.toMatch(/method: "(POST|PUT|PATCH|DELETE)"|body:/);
  });

  it("removes every listener and the timer when it unmounts", () => {
    expect(component).toMatch(/clearInterval\(timer\)/);
    expect(component).toMatch(/removeEventListener\("visibilitychange"/);
    expect(component).toMatch(/removeEventListener\("focus"/);
  });

  it("reads the same modal marker the drawers render, and asks the policy before every refresh", () => {
    expect(component).toMatch(/\[role="dialog"\]\[aria-modal="true"\]/);
    expect(component).toMatch(/shouldAutoRefresh\(/);
    const drawer = readFileSync("app/(app)/calendar/QuickBookDrawer.tsx", "utf8");
    expect(drawer).toMatch(/role="dialog"/);
    expect(drawer).toMatch(/aria-modal="true"/);
  });

  it("is on the toolbar every calendar view shares (week, month, team day)", () => {
    expect(toolbar).toMatch(/import \{ CalendarAutoRefresh, type ChangeProbeProps \} from "\.\/CalendarAutoRefresh"/);
    expect(toolbar).toMatch(/<CalendarAutoRefresh probe=\{changeProbe\} \/>/);
    const page = readFileSync("app/(app)/calendar/page.tsx", "utf8");
    expect([...page.matchAll(/<CalendarToolbar/g)]).toHaveLength(3);
    // Every view hands the toolbar the fingerprint of what it just drew, so the screen has something to compare with.
    expect([...page.matchAll(/changeProbe=\{changeProbe\}/g)]).toHaveLength(3);
  });
});

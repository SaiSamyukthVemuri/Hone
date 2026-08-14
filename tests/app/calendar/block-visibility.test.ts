import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { groupMonthBlockedByDate } from "@/app/(app)/calendar/month-blocked";
import {
  displayBlockoutLabel,
  displayRecurringBreakLabel,
  TIMED_BLOCK_LABEL,
} from "@/app/(app)/calendar/calendar-format";

// PR #300: calendar blocked-time visibility + open-hours clarity (Chloe pilot
// feedback). Month view now surfaces blocked time; the week full-day blockout
// shows its reason; open hours read more clearly. Render/source only, no
// booking-slot change, no settings IA change, no migration.

const TZ = "America/Toronto";
const neverClosed = () => false;

describe("displayBlockoutLabel (full-day blockout reason, fallback Blocked)", () => {
  it("shows the reason when present", () => {
    expect(displayBlockoutLabel("Vacation")).toBe("Vacation");
  });
  it("falls back to Blocked when no reason", () => {
    expect(displayBlockoutLabel(null)).toBe("Blocked");
    expect(displayBlockoutLabel("   ")).toBe("Blocked");
    expect(displayBlockoutLabel(undefined)).toBe("Blocked");
  });
});

describe("recurring break + timed block labels still resolve", () => {
  it("recurring break keeps its label (known + custom)", () => {
    expect(displayRecurringBreakLabel("lunch")).toBe("Lunch");
    expect(displayRecurringBreakLabel("Dinner")).toBe("Dinner");
    expect(displayRecurringBreakLabel(null)).toBe("Break");
  });
  it("timed block category maps to its label", () => {
    expect(TIMED_BLOCK_LABEL.lunch).toBe("Lunch");
    expect(TIMED_BLOCK_LABEL.meeting).toBe("Meeting");
    expect(TIMED_BLOCK_LABEL.other).toBe("Unavailable");
  });
});

describe("groupMonthBlockedByDate (month view receives block data)", () => {
  // A UTC instant whose Toronto-local date is the given YYYY-MM-DD at ~noon.
  const at = (date: string) => `${date}T16:00:00.000Z`; // 12:00 EDT

  it("marks every date a full-day blockout spans, carrying its reason", () => {
    const m = groupMonthBlockedByDate(
      [{ starts_on: "2026-07-06", ends_on: "2026-07-08", reason: "Vacation" }],
      [],
      [],
      TZ,
      neverClosed,
    );
    for (const d of ["2026-07-06", "2026-07-07", "2026-07-08"]) {
      expect(m.get(d)?.fullDay).toBe(true);
      expect(m.get(d)?.fullDayReason).toBe("Vacation");
    }
    expect(m.has("2026-07-09")).toBe(false);
  });

  it("collects timed-block + recurring-break labels per day", () => {
    const m = groupMonthBlockedByDate(
      [],
      [{ starts_at: at("2026-07-06"), category: "meeting" }],
      [{ starts_at: at("2026-07-06"), rule: { label: "Dinner" } }],
      TZ,
      neverClosed,
    );
    const row = m.get("2026-07-06");
    expect(row?.fullDay).toBe(false);
    expect(row?.labels).toContain("Meeting");
    expect(row?.labels).toContain("Dinner");
  });

  it("skips recurring breaks on closed dates (matches week view)", () => {
    const m = groupMonthBlockedByDate(
      [],
      [],
      [{ starts_at: at("2026-07-06"), rule: { label: "Lunch" } }],
      TZ,
      () => true, // closed
    );
    expect(m.has("2026-07-06")).toBe(false);
  });

  it("returns an empty map when there is nothing blocked", () => {
    expect(groupMonthBlockedByDate([], [], [], TZ, neverClosed).size).toBe(0);
  });
});

describe("calendar block-visibility wiring (source pins)", () => {
  const read = (rel: string) =>
    readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
  const PAGE = read("app/(app)/calendar/page.tsx");
  const MONTH = read("app/(app)/calendar/MonthView.tsx");
  const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");

  it("month render loads block data and passes blockedByDate to MonthView", () => {
    expect(PAGE).toMatch(/getBlockouts\(studio\.id\)/);
    expect(PAGE).toMatch(/getTimedBlocksForRange\(studio\.id, startUtc/);
    expect(PAGE).toMatch(/groupMonthBlockedByDate\(/);
    expect(PAGE).toMatch(/blockedByDate=\{blockedByDate\}/);
  });

  it("month view renders a blocked-time indicator from blockedByDate", () => {
    expect(MONTH).toMatch(/blockedByDate\.get\(cellDate\)/);
    expect(MONTH).toMatch(/\{blockedLabel\}/);
  });

  it("week view shows the blockout reason instead of hard-coded Blocked", () => {
    expect(DAYCOL).toMatch(/\{displayBlockoutLabel\(blockedReason\)\}/);
    // The bare hard-coded ">Blocked<" label node is gone.
    expect(DAYCOL).not.toMatch(/>\s*Blocked\s*</);
    expect(PAGE).toMatch(/blockedReason=\{blockoutReasonByDate\.get\(date\) \?\? null\}/);
  });

  it("open-hours tint uses a clearer (non-100/80) treatment", () => {
    // The prior too-subtle bg-neutral-100/80 fill is replaced.
    expect(DAYCOL).not.toMatch(/bg-neutral-100\/80/);
    expect(DAYCOL).toMatch(/bg-neutral-200\/70/);
  });

  it("does NOT touch booking-slot logic or settings IA", () => {
    // This PR is calendar render only.
    expect(PAGE).not.toMatch(/getAvailableSlots|SLOT_GRANULARITY|FALLBACK_GRANULARITY/);
    for (const src of [PAGE, MONTH, DAYCOL]) {
      expect(src).not.toMatch(/settings\/(availability|calendar)/);
    }
  });
});

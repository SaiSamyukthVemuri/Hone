import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatClockLabel, formatLocalDateLabel } from "@/lib/booking/tz";

// P1 fix: the drag-create "What would you like to do?" modal (and the quick-book
// drawer header) rendered raw 24h HH:MM ("2026-07-09 · 13:00 to 15:00") even
// when the studio prefers 12h. They now format via the shared helpers per the
// studio preference. Machine values (submitted HH:MM / positioning) are
// unchanged.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const CHOOSER = read("app/(app)/calendar/DragActionChooser.tsx");
const DRAWER = read("app/(app)/calendar/QuickBookDrawer.tsx");
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
const BLOCK = read("app/(app)/calendar/QuickBlockDrawer.tsx");

describe("formatClockLabel — 12h vs 24h from an HH:MM machine value", () => {
  it("12h mode renders 1:00 PM / 3:00 PM (not 13:00 / 15:00)", () => {
    expect(formatClockLabel("13:00", "12h")).toBe("1:00 PM");
    expect(formatClockLabel("15:00", "12h")).toBe("3:00 PM");
    expect(formatClockLabel("09:05", "12h")).toBe("9:05 AM");
    expect(formatClockLabel("00:30", "12h")).toBe("12:30 AM");
    expect(formatClockLabel("12:00", "12h")).toBe("12:00 PM");
  });
  it("24h mode renders 13:00 / 15:00", () => {
    expect(formatClockLabel("13:00", "24h")).toBe("13:00");
    expect(formatClockLabel("15:00", "24h")).toBe("15:00");
    expect(formatClockLabel("09:05", "24h")).toBe("09:05");
  });
  it("no 13:00–23:00 style output survives in 12h mode", () => {
    for (let h = 13; h <= 23; h++) {
      const out = formatClockLabel(`${h}:30`, "12h");
      expect(out).not.toMatch(/\b(1[3-9]|2[0-3]):[0-5]\d\b/);
      expect(out).toMatch(/\d{1,2}:\d{2}\s(AM|PM)/);
    }
  });
  it("returns the input unchanged when it isn't a valid HH:MM (machine-safe)", () => {
    expect(formatClockLabel("nope", "12h")).toBe("nope");
    expect(formatClockLabel("25:00", "12h")).toBe("25:00");
  });
});

describe("formatLocalDateLabel — human date, no timezone shift", () => {
  it("'2026-07-09' → 'Jul 9, 2026' (date unchanged, no off-by-one)", () => {
    expect(formatLocalDateLabel("2026-07-09")).toBe("Jul 9, 2026");
    expect(formatLocalDateLabel("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatLocalDateLabel("2026-12-31")).toBe("Dec 31, 2026");
  });
});

describe("DragActionChooser — the reported modal now uses the preference", () => {
  it("formats the range via the shared helpers, not raw HH:MM", () => {
    expect(CHOOSER).toMatch(/formatClockLabel\(draft\.startLocal, timeFormat\)/);
    expect(CHOOSER).toMatch(/formatClockLabel\(draft\.endLocal, timeFormat\)/);
    expect(CHOOSER).toMatch(/formatLocalDateLabel\(draft\.localDate\)/);
    // the old raw "{draft.startLocal} to {draft.endLocal}" is gone
    expect(CHOOSER).not.toMatch(/\{draft\.startLocal\} to \{draft\.endLocal\}/);
    expect(CHOOSER).not.toMatch(/\{draft\.localDate\} ·/);
  });
  it("receives timeFormat as a prop", () => {
    expect(CHOOSER).toMatch(/timeFormat: TimeFormat/);
  });
});

describe("QuickBookDrawer — header time honors the preference", () => {
  it("uses formatClockLabel (not the old locale-default toLocaleTimeString)", () => {
    expect(DRAWER).toMatch(/formatClockLabel\(draft\.localTime, timeFormat\)/);
    expect(DRAWER).not.toMatch(/toLocaleTimeString/);
  });
});

describe("DayColumn threads timeFormat into both modals", () => {
  it("passes timeFormat to DragActionChooser and QuickBookDrawer", () => {
    expect(DAYCOL).toMatch(/<DragActionChooser[\s\S]*?timeFormat=\{timeFormat\}/);
    expect(DAYCOL).toMatch(/<QuickBookDrawer[\s\S]*?timeFormat=\{timeFormat\}/);
  });
});

describe("machine/input values are unchanged (formatting-only fix)", () => {
  it("drag machine values (minutesToHHMM → startLocal/endLocal) stay 24h HH:MM", () => {
    expect(DAYCOL).toMatch(/function minutesToHHMM/);
    expect(DAYCOL).toMatch(/startLocal: minutesToHHMM\(/);
  });
  it("QuickBlockDrawer keeps 24h HH:MM inputs (block time is a machine value)", () => {
    expect(BLOCK).toMatch(/setStart\(draft\.startLocal\)/);
    expect(BLOCK).toMatch(/setEnd\(draft\.endLocal\)/);
    expect(BLOCK).not.toMatch(/formatClockLabel/); // inputs, not display labels
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatClockLabel } from "@/lib/booking/tz";

// P1: a VISIBLE calendar card inside the scroll grid — the live drag-selection
// preview overlay — still showed raw 24h ("11:45 to 14:00") when the studio
// prefers 12h. It now formats per the studio preference. Appointment + block
// cards were already fixed in PR #359 (dispStart/dispEnd via formatTimeForStudio);
// this pins every visible card label + confirms machine values stay 24h.

const DAYCOL = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/calendar/DayColumn.tsx"),
  "utf8",
);

describe("the reported case renders 12h (not military)", () => {
  it("'11:45 to 14:00' becomes '11:45 AM to 2:00 PM' in 12h mode", () => {
    expect(
      `${formatClockLabel("11:45", "12h")} to ${formatClockLabel("14:00", "12h")}`,
    ).toBe("11:45 AM to 2:00 PM");
  });
  it("stays '11:45 to 14:00' in 24h mode", () => {
    expect(
      `${formatClockLabel("11:45", "24h")} to ${formatClockLabel("14:00", "24h")}`,
    ).toBe("11:45 to 14:00");
  });
});

describe("every VISIBLE calendar card label uses the studio preference", () => {
  it("drag-selection preview overlay formats via formatClockLabel + timeFormat", () => {
    expect(DAYCOL).toMatch(/formatClockLabel\(overlay\.startLabel, timeFormat\)/);
    expect(DAYCOL).toMatch(/formatClockLabel\(overlay\.endLabel, timeFormat\)/);
    // the old raw "{overlay.startLabel} to {overlay.endLabel}" is gone
    expect(DAYCOL).not.toMatch(/\{overlay\.startLabel\} to \{overlay\.endLabel\}/);
  });
  it("appointment cards format via timeRangeLabel(dispStart, dispEnd) [PR #359]", () => {
    expect(DAYCOL).toMatch(/timeRangeLabel\(dispStart, dispEnd\)/);
    expect(DAYCOL).toMatch(/const dispStart = formatTimeForStudio\(start, tz, timeFormat\)/);
  });
  it("block/unavailable cards format via dispStart/dispEnd [PR #359]", () => {
    expect(DAYCOL).toMatch(/startLocal=\{dispStart\}/);
    expect(DAYCOL).toMatch(/endLocal=\{dispEnd\}/);
  });
  it("no visible card label renders a bare 24h range with the word 'to'", () => {
    // The only " to " between two braces would be a raw HH:MM overlay; it's gone.
    expect(DAYCOL).not.toMatch(/\{[a-zA-Z.]*Label\} to \{[a-zA-Z.]*Label\}/);
  });
});

describe("machine / positioning values are unchanged (display-only fix)", () => {
  it("drag draft + chooser submit the raw 24h minutesToHHMM machine values", () => {
    expect(DAYCOL).toMatch(/localTime: minutesToHHMM\(snapped\)/); // click draft
    expect(DAYCOL).toMatch(/startLocal: minutesToHHMM\(snappedStartTotal\)/); // chooser submit
    expect(DAYCOL).toMatch(/endLocal: minutesToHHMM\(snappedEndTotal\)/);
  });
  it("the overlay is positioned by top/height, not by the (now-formatted) labels", () => {
    expect(DAYCOL).toMatch(/style=\{\{ top: overlay\.top, height: overlay\.height \}\}/);
  });
  it("grid positioning still parses a 24h localTime (unchanged)", () => {
    expect(DAYCOL).toMatch(/const localTime = localTimeString\(start, tz\); \/\/ 24h/);
    expect(DAYCOL).toMatch(/localTime\.split\(":"\)\.map\(Number\)/);
  });
});

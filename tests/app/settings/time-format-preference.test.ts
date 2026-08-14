import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Studio time-format preference wiring (migration 0109). vitest env is "node"
// (no DOM) → the threading is verified by source pins. Formatter behavior is
// unit-tested in tests/lib/time-format.test.ts; the DB contract in
// tests/db/studio-time-format-preference.db.test.ts.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const HELPER = read("lib/booking/tz.ts");
const STUDIO_FORM = read("app/(app)/settings/studio/StudioSettingsForm.tsx");
const STUDIO_ACTION = read("app/(app)/settings/studio/actions.ts");
const CAL_PAGE = read("app/(app)/calendar/page.tsx");
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
const DASH = read("app/(app)/dashboard/page.tsx");
const BLOCKS = read("app/(app)/settings/availability/TimedBlocksSection.tsx");

describe("centralized helper (no ad-hoc formatting)", () => {
  it("exposes resolveTimeFormat + formatTimeForStudio + TimeFormat", () => {
    expect(HELPER).toMatch(/export type TimeFormat = "12h" \| "24h"/);
    expect(HELPER).toMatch(/export function resolveTimeFormat/);
    expect(HELPER).toMatch(/export function formatTimeForStudio/);
    // resolver defaults to 12h (pre-migration safe: undefined/null → 12h)
    expect(HELPER).toMatch(/time_format_preference === "24h" \? "24h" : "12h"/);
  });
});

describe("settings UI + save", () => {
  it("form offers a 12h/24h choice and submits time_format", () => {
    expect(STUDIO_FORM).toMatch(/12-hour · 2:30 PM/);
    expect(STUDIO_FORM).toMatch(/24-hour · 14:30/);
    expect(STUDIO_FORM).toMatch(/fd\.set\("time_format", timeFormat\)/);
    expect(STUDIO_FORM).toMatch(/initialTimeFormat/);
  });
  it("save writes time_format_preference best-effort (pre-migration safe) and defaults to 12h", () => {
    expect(STUDIO_ACTION).toMatch(/time_format_preference: timeFormat/);
    expect(STUDIO_ACTION).toMatch(/formData\.get\("time_format"\) === "24h" \? "24h" : "12h"/);
    // tolerate the missing column until 0109 is applied; surface other errors
    expect(STUDIO_ACTION).toMatch(/PGRST204|42703|time_format_preference/);
  });
});

describe("practitioner-facing surfaces use the preference", () => {
  it("calendar threads timeFormat into DayColumn + month labels", () => {
    expect(CAL_PAGE).toMatch(/resolveTimeFormat\(studio\)/);
    expect(CAL_PAGE).toMatch(/timeFormat=\{timeFormat\}/);
    expect(CAL_PAGE).toMatch(/formatTimeForStudio\(new Date\(iso\), tz, timeFormat\)/);
  });
  it("DayColumn formats DISPLAY via the helper but keeps 24h for positioning", () => {
    expect(DAYCOL).toMatch(/formatTimeForStudio\(start, tz, timeFormat\)/);
    // positioning still parses a 24h HH:MM string, must NOT be the display value
    expect(DAYCOL).toMatch(/const localTime = localTimeString\(start, tz\); \/\/ 24h/);
    expect(DAYCOL).toMatch(/localTime\.split\(":"\)\.map\(Number\)/);
  });
  it("dashboard roster uses the preference", () => {
    expect(DASH).toMatch(/formatTimeForStudio\(new Date\(appt\.starts_at\), tz, timeFormat\)/);
    expect(DASH).toMatch(/timeFormat=\{resolveTimeFormat\(studio\)\}/);
  });
  it("availability block DISPLAY uses the preference; the form INPUT stays 24h", () => {
    expect(BLOCKS).toMatch(/const time = formatTimeForStudio\(d, tz, format\)/); // display
    // the <input> value formatter is untouched (machine 24h HH:MM)
    expect(BLOCKS).toMatch(/function formatTimeForInput/);
    expect(BLOCKS).toMatch(/hour12: false/); // still present, for formatTimeForInput
  });
});

import { describe, expect, it } from "vitest";
import { resolveTimeFormat, formatTimeForStudio } from "@/lib/booking/tz";

// 2026-06-03T18:30:00Z → 2:30 PM / 14:30 in America/Toronto (EDT, UTC-4).
const D = new Date("2026-06-03T18:30:00Z");
const TZ = "America/Toronto";

describe("resolveTimeFormat: default 12h; no studio hardcoded", () => {
  it("defaults to 12h when the preference is absent or null (pre-migration safe)", () => {
    expect(resolveTimeFormat(undefined)).toBe("12h");
    expect(resolveTimeFormat(null)).toBe("12h");
    expect(resolveTimeFormat({})).toBe("12h"); // column absent (select * pre-0109)
    expect(resolveTimeFormat({ time_format_preference: null })).toBe("12h");
  });
  it("honors an explicit studio preference", () => {
    expect(resolveTimeFormat({ time_format_preference: "24h" })).toBe("24h");
    expect(resolveTimeFormat({ time_format_preference: "12h" })).toBe("12h");
  });
  it("treats any unknown value as the 12h default", () => {
    expect(resolveTimeFormat({ time_format_preference: "military" })).toBe("12h");
  });
});

describe("formatTimeForStudio: format only; timezone preserved", () => {
  it("renders 12h as '2:30 PM'", () => {
    expect(formatTimeForStudio(D, TZ, "12h")).toBe("2:30 PM");
  });
  it("renders 24h as '14:30'", () => {
    expect(formatTimeForStudio(D, TZ, "24h")).toBe("14:30");
  });
  it("applies the timezone identically for both formats (date/tz unchanged)", () => {
    // Same instant in Vancouver (UTC-7) is 11:30 AM / 11:30.
    expect(formatTimeForStudio(D, "America/Vancouver", "12h")).toBe("11:30 AM");
    expect(formatTimeForStudio(D, "America/Vancouver", "24h")).toBe("11:30");
  });
});

import { describe, expect, it } from "vitest";
import { localCalendarDays, localDateKey, localDateLabel } from "@/lib/receptionist/calendar-days";

// STUDIO-READY-02d (#824), Codex P2 4243875499 on #845: the front-desk schedule
// must show seven DISTINCT local days across a daylight-saving change.

describe("localCalendarDays", () => {
  it("gives seven distinct consecutive dates across the US fall-back (2026-11-01)", () => {
    const days = localCalendarDays("2026-10-29", 7);
    expect(days).toEqual([
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(new Set(days).size).toBe(7);
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(localCalendarDays("2027-12-30", 3)).toEqual(["2027-12-30", "2027-12-31", "2028-01-01"]);
    expect(localCalendarDays("2028-02-28", 3)).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  it("the defect it replaces: 24-hour steps from 00:30 local repeat a date at fall-back", () => {
    // 00:30 EDT on 2026-11-01 is 04:30Z; 24 hours later is 23:30 EST, still Nov 1.
    const start = Date.parse("2026-11-01T04:30:00Z");
    const stepped = [0, 1].map((i) => localDateKey(new Date(start + i * 86_400_000).toISOString(), "America/Toronto"));
    expect(stepped).toEqual(["2026-11-01", "2026-11-01"]);
  });
});

describe("localDateKey and localDateLabel", () => {
  it("keys an instant by the studio's local date, and labels the date itself", () => {
    expect(localDateKey("2026-11-01T06:30:00Z", "America/Los_Angeles")).toBe("2026-10-31");
    expect(localDateLabel("2026-11-01")).toBe("Sunday, Nov 1");
  });
});

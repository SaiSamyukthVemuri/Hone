import { describe, expect, it } from "vitest";
import { formatInstant } from "@/components/formatted-date-time";

// The Roles history shows each change in the STUDIO's timezone, not the viewer's.
describe("formatInstant", () => {
  const iso = "2026-11-03T03:47:26.054514+00:00";
  it("renders the same instant on the studio's clock, and not the raw ISO text", () => {
    const toronto = formatInstant(iso, "datetime", "America/Toronto");
    const tokyo = formatInstant(iso, "datetime", "Asia/Tokyo");
    expect(toronto).toMatch(/Nov 2, 2026/); // 22:47 the day before, in Toronto
    expect(toronto).toMatch(/10:47/);
    expect(tokyo).toMatch(/Nov 3, 2026/);
    expect(toronto).not.toContain("T03:47");
  });
  it("uses the viewer's zone when none is given, as before", () => {
    expect(formatInstant(iso, "date")).toBe(new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric" }));
  });
});

import { describe, expect, it } from "vitest";
import { formatStudioDateTime, formatStudioTime, localParts, studioLocalToInstant } from "@/lib/desk/time";

// The desk reads and writes times in the STUDIO's clock, never the device's.

describe("studioLocalToInstant", () => {
  it("converts a studio-local reading to the right instant (winter and summer offsets)", () => {
    expect(studioLocalToInstant("2031-01-15", "09:30", "America/Toronto")).toBe("2031-01-15T14:30:00.000Z");
    expect(studioLocalToInstant("2031-07-15", "09:30", "America/Toronto")).toBe("2031-07-15T13:30:00.000Z");
    expect(studioLocalToInstant("2031-07-15", "09:30", "UTC")).toBe("2031-07-15T09:30:00.000Z");
  });

  it("refuses malformed input and impossible readings", () => {
    for (const [d, t] of [["2031-1-5", "09:30"], ["2031-01-15", "9:30"], ["2031-13-01", "09:00"], ["2031-01-15", "24:00"], ["", ""]]) {
      expect(studioLocalToInstant(d, t, "UTC")).toBeNull();
    }
    expect(studioLocalToInstant("2031-02-31", "09:00", "UTC")).toBeNull();
  });

  it("refuses a local time that does not exist (spring-forward gap)", () => {
    expect(studioLocalToInstant("2031-03-09", "02:30", "America/Toronto")).toBeNull();
    expect(studioLocalToInstant("2031-03-09", "03:30", "America/Toronto")).not.toBeNull(); // control
  });

  it("takes the first occurrence of an ambiguous time (fall-back overlap)", () => {
    expect(studioLocalToInstant("2031-11-02", "01:30", "America/Toronto")).toBe("2031-11-02T05:30:00.000Z");
  });

  it("an unknown zone is null, not a guess", () => {
    expect(studioLocalToInstant("2031-01-15", "09:30", "Not/AZone")).toBeNull();
  });
});

describe("localParts and formatting", () => {
  it("round-trips through the studio zone", () => {
    const iso = studioLocalToInstant("2031-07-15", "09:30", "America/Toronto")!;
    expect(localParts(iso, "America/Toronto")).toEqual({ date: "2031-07-15", time: "09:30" });
    expect(localParts("nope", "UTC")).toBeNull();
  });

  it("formats in the studio zone, falling back to UTC for an unusable one", () => {
    expect(formatStudioTime("2031-01-15T14:30:00Z", "America/Toronto")).toMatch(/9:30\sAM/);
    expect(formatStudioTime("2031-01-15T14:30:00Z", "Not/AZone")).toMatch(/2:30\sPM/);
    expect(formatStudioDateTime("2031-01-15T14:30:00Z", "America/Toronto")).toMatch(/9:30\sAM/);
    expect(formatStudioDateTime("garbage", "UTC")).toBe("");
  });
});

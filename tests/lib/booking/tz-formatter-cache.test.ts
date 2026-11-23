import { describe, expect, it } from "vitest";
import { localDateString, localTimeString } from "@/lib/booking/tz";

// The date and time formatters are kept per zone (building one dominated the Analytics build). The output must be exactly what a freshly built formatter gives.
const fresh = {
  date: (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
  time: (d: Date, tz: string) => {
    const t = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    return t.startsWith("24:") ? `00:${t.slice(3)}` : t;
  },
};
const ZONES = ["America/Toronto", "UTC", "Pacific/Kiritimati", "Asia/Kolkata", "Europe/London"];
const INSTANTS = ["2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z", "2026-11-01T05:59:59Z", "2026-11-01T06:00:00Z", "2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z", "2026-06-15T04:00:00Z"];

describe("per-zone formatters give the same text as a new formatter each time", () => {
  it("dates and times, across zones, daylight-saving edges and midnight, called repeatedly and in mixed order", () => {
    for (let round = 0; round < 3; round++)
      for (const tz of ZONES)
        for (const iso of INSTANTS) {
          const d = new Date(iso);
          expect(localDateString(d, tz), `${tz} ${iso}`).toBe(fresh.date(d, tz));
          expect(localTimeString(d, tz), `${tz} ${iso}`).toBe(fresh.time(d, tz));
        }
  });
  it("an invalid zone still throws on every call (a failed build is not stored)", () => {
    expect(() => localDateString(new Date(), "Not/AZone")).toThrow(RangeError);
    expect(() => localDateString(new Date(), "Not/AZone")).toThrow(RangeError);
    expect(() => localTimeString(new Date(), "Not/AZone")).toThrow(RangeError);
    expect(localDateString(new Date("2026-06-15T12:00:00Z"), "UTC")).toBe("2026-06-15");
  });
});

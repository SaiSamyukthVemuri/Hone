import { describe, expect, it } from "vitest";
import { checkPrintableDay } from "@/lib/records/print/day-guard";

const NOW = new Date("2026-11-07T15:00:00.000Z"); // 10:00 on 7 Nov in Toronto
const TZ = "America/Toronto";

describe("checkPrintableDay (Privacy B-2: bound the day BEFORE the audit)", () => {
  it("accepts today and past days inside 1900-2100", () => {
    for (const d of ["2026-11-07", "2026-11-06", "2000-01-01", "1900-01-01"]) expect(checkPrintableDay(d, TZ, NOW), d).toEqual({ ok: true });
  });
  it("refuses years outside the window", () => {
    for (const d of ["9999-12-31", "0001-01-01", "1899-12-31", "2101-01-01"]) expect(checkPrintableDay(d, TZ, NOW), d).toEqual({ ok: false, reason: "out_of_range" });
  });
  it("refuses a day after the studio's today, judged in the STUDIO timezone", () => {
    expect(checkPrintableDay("2026-11-08", TZ, NOW)).toEqual({ ok: false, reason: "future" });
    // 03:00Z on 8 Nov is still 7 Nov in Toronto but already 8 Nov in Auckland.
    const late = new Date("2026-11-08T03:00:00.000Z");
    expect(checkPrintableDay("2026-11-08", TZ, late)).toEqual({ ok: false, reason: "future" });
    expect(checkPrintableDay("2026-11-08", "Pacific/Auckland", late)).toEqual({ ok: true });
  });
  it("an unresolvable timezone refuses instead of guessing today", () => {
    expect(checkPrintableDay("2026-11-06", "Not/AZone", NOW)).toEqual({ ok: false, reason: "out_of_range" });
  });
});

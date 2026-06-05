import { describe, expect, it } from "vitest";
import {
  localTimeString,
  localTimeString12h,
} from "@/lib/booking/tz";

// PR #157 patch. The 12h helper backs the AM/PM in every client-
// facing email (confirmation, reminder, postcare, cancellation). Pin
// the actual format strings so a future refactor that flips locale
// or hour12 is caught by `npm test`.

describe("localTimeString12h returns 12-hour AM/PM strings", () => {
  it("renders 11:00 UTC in UTC as 11:00 AM", () => {
    const d = new Date("2026-06-09T11:00:00Z");
    expect(localTimeString12h(d, "UTC")).toBe("11:00 AM");
  });

  it("renders 12:00 UTC in UTC as 12:00 PM (noon disambiguation)", () => {
    const d = new Date("2026-06-09T12:00:00Z");
    expect(localTimeString12h(d, "UTC")).toBe("12:00 PM");
  });

  it("renders 00:00 UTC in UTC as 12:00 AM (midnight disambiguation)", () => {
    const d = new Date("2026-06-09T00:00:00Z");
    expect(localTimeString12h(d, "UTC")).toBe("12:00 AM");
  });

  it("renders 23:30 UTC in UTC as 11:30 PM (high-end of the range)", () => {
    const d = new Date("2026-06-09T23:30:00Z");
    expect(localTimeString12h(d, "UTC")).toBe("11:30 PM");
  });

  it("respects the IANA timezone (15:00 UTC in America/Toronto in summer DST = 11:00 AM)", () => {
    // 2026-06-09 falls in EDT (UTC-4).
    const d = new Date("2026-06-09T15:00:00Z");
    expect(localTimeString12h(d, "America/Toronto")).toBe("11:00 AM");
  });
});

// ---------------------------------------------------------------------------
// 24h helper is unchanged and still used by the practitioner-facing
// calendar grid + dashboard. Pin it explicitly so a future refactor
// that decides to converge the two helpers does so deliberately,
// not by accident.
// ---------------------------------------------------------------------------

describe("localTimeString stays 24h (practitioner calendar / dashboard contract)", () => {
  it("renders 11:00 UTC in UTC as 11:00", () => {
    const d = new Date("2026-06-09T11:00:00Z");
    expect(localTimeString(d, "UTC")).toBe("11:00");
  });

  it("renders 23:30 UTC in UTC as 23:30 (no AM/PM)", () => {
    const d = new Date("2026-06-09T23:30:00Z");
    expect(localTimeString(d, "UTC")).toBe("23:30");
  });
});

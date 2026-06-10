import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  localDateString,
  localTimeString,
  localTimeString12h,
  tzOffsetMinutes,
} from "@/lib/booking/tz";

// PR #185. Some ICU builds resolve Intl's `hour12: false` to the h24
// hour cycle and render hour 0 as "24" ("24:30" instead of "00:30");
// the PR #184 CI run surfaced this when its runner ICU emitted 24:xx
// where dev machines emitted 00:xx. localTimeString now normalizes
// the rendered string so HH is always 00-23. The behavioral tests
// below are meaningful on EVERY ICU: on an h24-cycle build they fail
// without the normalization, on an h23-cycle build they pass
// trivially, so CI and dev machines together cover both branches.

const TZ_SOURCE = readFileSync(
  path.resolve(__dirname, "../../../lib/booking/tz.ts"),
  "utf8",
);

describe("localTimeString: midnight hour renders as 00, never 24", () => {
  it("00:30 UTC in UTC renders as 00:30", () => {
    expect(localTimeString(new Date("2026-06-10T00:30:00Z"), "UTC")).toBe(
      "00:30",
    );
  });

  it("00:00 UTC in UTC renders as 00:00", () => {
    expect(localTimeString(new Date("2026-06-10T00:00:00Z"), "UTC")).toBe(
      "00:00",
    );
  });

  it("half past local midnight in Toronto renders as 00:30", () => {
    // 2026-06-10T04:30:00Z is 00:30 EDT.
    expect(
      localTimeString(new Date("2026-06-10T04:30:00Z"), "America/Toronto"),
    ).toBe("00:30");
  });

  it("never returns a 24:xx string across the full midnight hour", () => {
    for (let m = 0; m < 60; m += 5) {
      const d = new Date(Date.UTC(2026, 5, 10, 0, m));
      expect(localTimeString(d, "UTC")).toBe(
        `00:${String(m).padStart(2, "0")}`,
      );
    }
  });
});

describe("localTimeString: non-midnight times unchanged", () => {
  it("14:05 stays 14:05", () => {
    expect(localTimeString(new Date("2026-06-10T14:05:00Z"), "UTC")).toBe(
      "14:05",
    );
  });

  it("23:59 stays 23:59 (top of the valid range)", () => {
    expect(localTimeString(new Date("2026-06-10T23:59:00Z"), "UTC")).toBe(
      "23:59",
    );
  });

  it("01:00 stays 01:00 (adjacent to the normalized hour)", () => {
    expect(localTimeString(new Date("2026-06-10T01:00:00Z"), "UTC")).toBe(
      "01:00",
    );
  });
});

describe("sibling helpers unaffected", () => {
  it("localTimeString12h renders midnight as 12:30 AM (h12 cycle, no 24)", () => {
    expect(localTimeString12h(new Date("2026-06-10T00:30:00Z"), "UTC")).toBe(
      "12:30 AM",
    );
  });

  it("localDateString is date-only and ignores the hour cycle", () => {
    expect(localDateString(new Date("2026-06-10T00:30:00Z"), "UTC")).toBe(
      "2026-06-10",
    );
  });

  it("tzOffsetMinutes is correct at a local-midnight instant (its own hour-24 guard)", () => {
    // 2026-06-10T04:30:00Z = 00:30 EDT; offset must be -240 even on
    // an ICU that reports the hour part as 24.
    expect(
      tzOffsetMinutes(new Date("2026-06-10T04:30:00Z"), "America/Toronto"),
    ).toBe(-240);
  });

  it("tzOffsetMinutes keeps its numeric hour-24 normalization in source", () => {
    expect(TZ_SOURCE).toMatch(/if \(hour === 24\) hour = 0;/);
  });
});

describe("PR #185 boundaries", () => {
  it("localTimeString routes through the normalization helper in source", () => {
    expect(TZ_SOURCE).toMatch(/return normalizeHour24\(f\.format\(d\)\);/);
  });

  it("utcInstantFromLocal is untouched (still the PR #184 two-pass shape)", () => {
    expect(TZ_SOURCE).toMatch(
      /const secondOffsetMin = tzOffsetMinutes\(new Date\(corrected\), tz\);/,
    );
  });

  it("tz.ts stays zero-dependency (no date library imports)", () => {
    expect(TZ_SOURCE).not.toMatch(/from "(date-fns|dayjs|luxon|moment|@js-joda)/);
    expect(TZ_SOURCE).not.toMatch(/require\(/);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  civilDateParts,
  clinicalDateInputValue,
  formatClinicalDate,
} from "@/lib/clinical-notes/clinical-date";

// `client_clinical_notes.occurred_at` is a CALENDAR DATE. The form posts
// `YYYY-MM-DD` from an <input type="date">, the column is timestamptz, so it
// lands at midnight UTC and reads back as `2026-07-21T00:00:00+00:00`.
//
// Rendering that through `new Date(iso).toLocaleDateString()` converts an
// instant into the viewer's zone: in EVERY negative UTC offset — every Canadian
// and US studio, Willow included — midnight UTC on the 21st is 8pm on the 20th,
// so a note dated July 21 displayed as July 20, disagreeing with the date in
// its own input field.
//
// These tests run the formatter under real IANA zones by setting process.TZ,
// which is what `toLocaleDateString` reads for its default zone.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
// Strip comments so "must NOT contain" assertions test CODE, not the prose in
// a file's own header (which deliberately names the pattern it avoids).
const codeOnly = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function inZone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

// The exact stored shape: a date-only value written into a timestamptz.
const JULY_21 = "2026-07-21T00:00:00+00:00";

const ZONES = [
  "America/Toronto", // Chloe / Willow — UTC-4 in July. The reported defect.
  "America/Los_Angeles", // UTC-7 — the worst negative offset in scope.
  "UTC",
  "Asia/Kolkata", // UTC+5:30 — a half-hour positive offset.
  "Pacific/Kiritimati", // UTC+14 — the extreme positive offset.
];

describe("the stored calendar date renders as itself in every timezone", () => {
  for (const tz of ZONES) {
    it(`${tz} shows July 21, never July 20 or 22`, () => {
      const out = inZone(tz, () => formatClinicalDate(JULY_21));
      expect(out).toMatch(/Jul(y)?\b/);
      expect(out).toContain("21");
      expect(out).toContain("2026");
      expect(out).not.toContain("20,");
      expect(out).not.toContain("22,");
    });
  }

  it("Toronto NEVER shows the prior date — the exact reported defect", () => {
    // The naive rendering, reproduced, so this test proves the difference
    // rather than merely asserting the fixed value.
    const naive = inZone("America/Toronto", () =>
      new Date(JULY_21).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    );
    const fixed = inZone("America/Toronto", () => formatClinicalDate(JULY_21));
    expect(naive).toContain("20"); // the bug: July 20
    expect(fixed).toContain("21"); // the fix: July 21
    expect(fixed).not.toBe(naive);
  });

  it("every zone agrees with every other zone", () => {
    const rendered = ZONES.map((tz) =>
      inZone(tz, () => formatClinicalDate(JULY_21)),
    );
    expect(new Set(rendered).size).toBe(1);
  });
});

describe("DST boundaries and awkward dates", () => {
  const cases: Array<[string, string, string]> = [
    // [label, stored value, expected day-of-month]
    ["mid-winter, NOT in DST", "2026-01-15T00:00:00+00:00", "15"],
    ["mid-summer, IN DST", "2026-07-15T00:00:00+00:00", "15"],
    ["the day DST starts in Toronto", "2026-03-08T00:00:00+00:00", "8"],
    ["the day DST ends in Toronto", "2026-11-01T00:00:00+00:00", "1"],
    ["New Year's Day (year would roll back)", "2026-01-01T00:00:00+00:00", "1"],
    ["New Year's Eve", "2026-12-31T00:00:00+00:00", "31"],
    ["a real leap day", "2028-02-29T00:00:00+00:00", "29"],
    ["the 1st of a month (would roll to prior month)", "2026-06-01T00:00:00+00:00", "1"],
  ];

  for (const [label, iso, day] of cases) {
    it(`${label} holds in Toronto and Los Angeles`, () => {
      for (const tz of ["America/Toronto", "America/Los_Angeles"]) {
        const out = inZone(tz, () => formatClinicalDate(iso));
        expect(out, `${tz} / ${iso}`).toContain(day);
      }
    });
  }

  it("New Year's Day does not roll the YEAR back in a negative offset", () => {
    const out = inZone("America/Los_Angeles", () =>
      formatClinicalDate("2026-01-01T00:00:00+00:00"),
    );
    expect(out).toContain("2026");
    expect(out).not.toContain("2025");
  });
});

describe("invalid input degrades, never throws", () => {
  const bad = [
    null,
    undefined,
    "",
    "   ",
    "not a date",
    "2026-13-01T00:00:00Z", // month 13
    "2026-02-30T00:00:00Z", // impossible calendar date
    "2027-02-29T00:00:00Z", // not a leap year
    "2026-00-10T00:00:00Z", // month 0
    "2026-07-00T00:00:00Z", // day 0
    "26-07-21", // not ISO
    123 as unknown as string,
    {} as unknown as string,
  ];

  for (const value of bad) {
    it(`returns "" for ${JSON.stringify(value)}`, () => {
      expect(() => formatClinicalDate(value)).not.toThrow();
      expect(formatClinicalDate(value)).toBe("");
      expect(civilDateParts(value)).toBeNull();
      expect(clinicalDateInputValue(value)).toBe("");
    });
  }

  it("an impossible date is rejected, never silently rolled over", () => {
    // new Date(Date.UTC(2026, 1, 30)) would silently become March 2.
    expect(civilDateParts("2026-02-30")).toBeNull();
    expect(formatClinicalDate("2026-02-30")).toBe("");
  });

  it("a real leap day is accepted", () => {
    expect(civilDateParts("2028-02-29")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });
});

describe("parsing and round-tripping", () => {
  it("reads the civil-date portion, ignoring any time-of-day", () => {
    expect(civilDateParts("2026-07-21T00:00:00+00:00")).toEqual({
      year: 2026,
      month: 7,
      day: 21,
    });
    // A value stored with a real time still denotes its own calendar day.
    expect(civilDateParts("2026-07-21T23:59:59-07:00")).toEqual({
      year: 2026,
      month: 7,
      day: 21,
    });
    expect(civilDateParts("2026-07-21")).toEqual({
      year: 2026,
      month: 7,
      day: 21,
    });
  });

  it("round-trips to the date-input shape, zero-padded", () => {
    expect(clinicalDateInputValue("2026-07-21T00:00:00+00:00")).toBe("2026-07-21");
    expect(clinicalDateInputValue("2026-01-05T00:00:00+00:00")).toBe("2026-01-05");
  });

  it("the input value is timezone-independent too", () => {
    for (const tz of ZONES) {
      expect(inZone(tz, () => clinicalDateInputValue(JULY_21))).toBe("2026-07-21");
    }
  });

  it("month names still follow the requested locale", () => {
    expect(formatClinicalDate(JULY_21, { locale: "en-US" })).toMatch(/Jul/);
    expect(formatClinicalDate(JULY_21, { locale: "fr-FR" })).toMatch(/juil/i);
    // …but the DAY never moves, whatever the locale.
    expect(formatClinicalDate(JULY_21, { locale: "fr-FR" })).toContain("21");
  });

  it("an invalid locale tag falls back instead of throwing", () => {
    expect(() =>
      formatClinicalDate(JULY_21, { locale: "!!not-a-locale!!" }),
    ).not.toThrow();
    expect(formatClinicalDate(JULY_21, { locale: "!!not-a-locale!!" })).toContain(
      "21",
    );
  });

  it("a caller cannot override the UTC pin — that override IS the defect", () => {
    const out = inZone("America/Toronto", () =>
      formatClinicalDate(JULY_21, {
        options: { timeZone: "America/Toronto" } as Intl.DateTimeFormatOptions,
      }),
    );
    expect(out).toContain("21");
  });
});

describe("every clinical-note date surface uses the shared formatter", () => {
  it("ClinicalNotesSection no longer converts the calendar date to local time", () => {
    const src = read("components/clinical-notes-section.tsx");
    expect(src).toMatch(
      /import \{ formatClinicalDate \} from "@\/lib\/clinical-notes\/clinical-date"/,
    );
    expect(src).toMatch(/const formatDate = formatClinicalDate/);
    // The old naive implementation must be gone.
    expect(codeOnly("components/clinical-notes-section.tsx")).not.toMatch(
      /new Date\(iso\)\.toLocaleDateString/,
    );
  });

  it("the Last treatment memory card renders note dates as civil dates", () => {
    const src = read("components/last-treatment-memory-card.tsx");
    expect(src).toMatch(/<ClinicalDate iso=\{note\.occurredAt\}/);
    expect(src).not.toMatch(/<FormattedDateTime iso=\{note\.occurredAt\}/);
  });

  it("REAL INSTANTS still render in the viewer's timezone", () => {
    // The session's own start time is a moment, not a calendar date, and must
    // NOT be routed through the civil-date formatter.
    const src = read("components/last-treatment-memory-card.tsx");
    expect(src).toMatch(/<FormattedDateTime iso=\{memory\.startedAt\}/);
    expect(src).not.toMatch(/<ClinicalDate iso=\{memory\.startedAt\}/);
  });

  it("the civil-date component pins UTC and needs no hydration suppression", () => {
    const lib = read("lib/clinical-notes/clinical-date.ts");
    expect(lib).toMatch(/timeZone: "UTC"/);
    const cmp = codeOnly("components/clinical-date.tsx");
    expect(cmp).not.toMatch(/suppressHydrationWarning/);
    expect(cmp).not.toMatch(/useEffect/);
  });
});

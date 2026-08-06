import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HONE_CLINICAL_DATE_LOCALE,
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

  it("a stored value carrying a real TIME still renders its own stored day", () => {
    // Not every occurred_at comes from the date input: the column defaults to
    // now() when the form omits it, so some rows hold a real instant. The
    // formatter reads the stored civil date either way and never lets the
    // FORMATTER's own instant-parsing shift it. (This is what made a naive
    // `new Date(iso)` implementation indistinguishable in the earlier tests.)
    const withTime = "2026-07-21T23:59:59+00:00";
    for (const tz of ZONES) {
      const out = inZone(tz, () => formatClinicalDate(withTime));
      expect(out, tz).toContain("21");
      expect(out, tz).not.toContain("22");
    }
    expect(civilDateParts(withTime)).toEqual({ year: 2026, month: 7, day: 21 });
  });

  it("a NON-UTC stored offset still renders the stored day — the UTC pin alone cannot save this", () => {
    // The test above uses a +00:00 offset, where reading the civil date
    // textually and parsing the string as an instant happen to AGREE. That
    // makes it blind to the parsing half of the contract: swap
    // `Date.UTC(parts…)` back for a naive `new Date(iso)` and it still passes,
    // because `timeZone: "UTC"` rescues the result.
    //
    // A NEGATIVE offset late in the day separates them. occurred_at is
    // `timestamptz` (migration 0126), so the wire value carries whatever offset
    // the emitting connection used; only the +00:00 case is self-correcting.
    //   naive  new Date("2026-07-21T23:30:00-04:00") -> 2026-07-22T03:30Z -> "Jul 22"
    //   civil  parts {2026,7,21}                                          -> "Jul 21"
    // So this is the assertion that pins the EXTRACTION, independently of the
    // zone pin — and it is what makes the "restore the old instant conversion"
    // negative control go red.
    const negativeOffset = "2026-07-21T23:30:00-04:00";
    expect(civilDateParts(negativeOffset)).toEqual({ year: 2026, month: 7, day: 21 });
    for (const tz of ZONES) {
      const out = inZone(tz, () => formatClinicalDate(negativeOffset));
      expect(out, tz).toContain("21");
      expect(out, tz).not.toContain("22");
    }
    // And the date-input round trip agrees with it.
    expect(clinicalDateInputValue(negativeOffset)).toBe("2026-07-21");
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

  it("an EXPLICIT locale override still works (deliberate callers, pure tests)", () => {
    // This is an override a caller asks for by name. It is NOT how the
    // component renders — the component passes no locale, so it always gets
    // the deterministic application default.
    expect(formatClinicalDate(JULY_21, { locale: "en-US" })).toMatch(/Jul/);
    expect(formatClinicalDate(JULY_21, { locale: "fr-FR" })).toMatch(/juil/i);
    // …and the DAY never moves, whatever the locale.
    expect(formatClinicalDate(JULY_21, { locale: "fr-FR" })).toContain("21");
  });

  it("the DEFAULT does not follow the viewer — it follows Hone's locale", () => {
    expect(HONE_CLINICAL_DATE_LOCALE).toBe("en-CA");
    // The no-options call equals the app-locale call, and is unaffected by any
    // other runtime preference.
    expect(formatClinicalDate(JULY_21)).toBe(
      formatClinicalDate(JULY_21, { locale: HONE_CLINICAL_DATE_LOCALE }),
    );
    expect(formatClinicalDate(JULY_21)).not.toBe(
      formatClinicalDate(JULY_21, { locale: "fr-FR" }),
    );
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

describe("the DEFAULT LOCALE is explicit, never the runtime's", () => {
  // WHY THIS IS NOT AN OUTPUT ASSERTION.
  //
  // en-US and en-CA render this date IDENTICALLY ("Jul 21, 2026"), and the CI
  // runner defaults to en-US. So a test that only inspects the returned string
  // would pass even if the implementation reverted to
  // `toLocaleDateString(undefined, …)` — the exact defect. These tests inspect
  // the ARGUMENT instead, and simulate the two runtimes explicitly.

  const realToLocaleDateString = Date.prototype.toLocaleDateString;
  afterEach(() => {
    Date.prototype.toLocaleDateString = realToLocaleDateString;
  });

  it("passes the explicit application locale AND the UTC pin to the formatter", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("stubbed");

    formatClinicalDate(JULY_21);

    expect(spy).toHaveBeenCalledTimes(1);
    const [locale, options] = spy.mock.calls[0] as [
      string | undefined,
      Intl.DateTimeFormatOptions,
    ];
    // Reverting to `toLocaleDateString(undefined, …)` reds exactly here.
    expect(locale).toBe("en-CA");
    expect(locale).not.toBeUndefined();
    expect(options.timeZone).toBe("UTC");
    spy.mockRestore();
  });

  it("an explicit caller locale is still forwarded verbatim", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("stubbed");
    formatClinicalDate(JULY_21, { locale: "fr-FR" });
    expect((spy.mock.calls[0] as [string])[0]).toBe("fr-FR");
    spy.mockRestore();
  });

  it("the UTC pin cannot be overridden by a caller's options", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("stubbed");
    formatClinicalDate(JULY_21, {
      options: { timeZone: "America/Toronto" } as Intl.DateTimeFormatOptions,
    });
    const options = (spy.mock.calls[0] as [unknown, Intl.DateTimeFormatOptions])[1];
    expect(options.timeZone).toBe("UTC");
    spy.mockRestore();
  });

  it("SERVER (en-US default) and BROWSER (fr-CA default) produce the SAME string", () => {
    // A Client Component is rendered twice — once by Node, once by the browser
    // — and `undefined` means "each runtime's own default". This models that
    // divergence directly: the stub resolves `undefined` to an INJECTED runtime
    // default, exactly as a real runtime would.
    function underRuntimeDefault<T>(runtimeDefault: string, fn: () => T): T {
      Date.prototype.toLocaleDateString = function (
        this: Date,
        locale?: string | string[],
        options?: Intl.DateTimeFormatOptions,
      ) {
        return realToLocaleDateString.call(
          this,
          locale ?? runtimeDefault,
          options,
        );
      } as typeof Date.prototype.toLocaleDateString;
      try {
        return fn();
      } finally {
        Date.prototype.toLocaleDateString = realToLocaleDateString;
      }
    }

    const onServer = underRuntimeDefault("en-US", () =>
      formatClinicalDate(JULY_21),
    );
    const inBrowser = underRuntimeDefault("fr-CA", () =>
      formatClinicalDate(JULY_21),
    );

    // The hydration guarantee.
    expect(onServer).toBe(inBrowser);
    expect(onServer).toBe(formatClinicalDate(JULY_21, { locale: "en-CA" }));

    // And the control: those two runtime defaults REALLY DO diverge, so the
    // assertion above is not vacuous.
    const naiveServer = underRuntimeDefault("en-US", () =>
      new Date(Date.UTC(2026, 6, 21)).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    );
    const naiveBrowser = underRuntimeDefault("fr-CA", () =>
      new Date(Date.UTC(2026, 6, 21)).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    );
    expect(naiveServer).not.toBe(naiveBrowser);
  });

  it("holds across every zone AND every runtime default at once", () => {
    const outputs: string[] = [];
    for (const tz of ZONES) {
      for (const runtimeDefault of ["en-US", "fr-CA", "de-DE", "ja-JP"]) {
        outputs.push(
          inZone(tz, () => {
            Date.prototype.toLocaleDateString = function (
              this: Date,
              locale?: string | string[],
              options?: Intl.DateTimeFormatOptions,
            ) {
              return realToLocaleDateString.call(
                this,
                locale ?? runtimeDefault,
                options,
              );
            } as typeof Date.prototype.toLocaleDateString;
            try {
              return formatClinicalDate(JULY_21);
            } finally {
              Date.prototype.toLocaleDateString = realToLocaleDateString;
            }
          }),
        );
      }
    }
    expect(new Set(outputs).size).toBe(1);
    expect(outputs[0]).toContain("21");
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

  it("BOTH axes are pinned in source — locale AND zone, not zone alone", () => {
    const lib = codeOnly("lib/clinical-notes/clinical-date.ts");
    // Zone: the day.
    expect(lib).toMatch(/timeZone: "UTC"/);
    // Locale: the TEXT. UTC alone does not make hydration safe.
    expect(lib).toMatch(/HONE_CLINICAL_DATE_LOCALE = "en-CA"/);
    expect(lib).toMatch(/opts\.locale \?\? HONE_CLINICAL_DATE_LOCALE/);
    // The runtime-dependent default must appear nowhere in the format calls.
    expect(lib).not.toMatch(/toLocaleDateString\(undefined/);
    expect(lib).not.toMatch(/toLocaleDateString\(opts\.locale/);
  });

  it("the component defers entirely to the deterministic default", () => {
    const cmp = codeOnly("components/clinical-date.tsx");
    // It passes NO locale of its own…
    expect(cmp).toMatch(/formatClinicalDate\(iso\)/);
    // …and never derives one from the browser.
    expect(cmp).not.toMatch(/navigator/);
    expect(cmp).not.toMatch(/languages?\b/);
    expect(cmp).not.toMatch(/documentElement/);
    expect(cmp).not.toMatch(/Intl\./);
    expect(cmp).not.toMatch(/resolvedOptions/);
  });

  it("the mismatch is REMOVED, never hidden or deferred", () => {
    const cmp = codeOnly("components/clinical-date.tsx");
    for (const escape of [
      "suppressHydrationWarning",
      "useEffect",
      "useState",
      "ssr: false",
      "dynamic(",
    ]) {
      expect(cmp, `must not use ${escape}`).not.toContain(escape);
    }
  });
});

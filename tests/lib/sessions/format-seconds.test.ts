import { describe, expect, it } from "vitest";
import { formatSeconds } from "@/lib/sessions/format-seconds";

// PR #165. Pin the formatter behavior. Chloe's bug was that
// thermolysis duration of 0.15 silently rendered as "0 seconds"
// in the entry-row display. Migration 0071 widened the column to
// numeric; this helper drives the read view so a future refactor
// that re-introduces integer rounding is caught by `npm test`.

describe("formatSeconds returns practitioner-facing duration labels", () => {
  it("renders fractional values without rounding down (the bug)", () => {
    expect(formatSeconds(0.15)).toBe("0.15 seconds");
    expect(formatSeconds(0.2)).toBe("0.2 seconds");
    expect(formatSeconds(0.25)).toBe("0.25 seconds");
  });

  it("shows the EXACT stored 3-decimal thermolysis duration (Chloe's PicoBlend 0.733s)", () => {
    // The load-bearing clinical guarantee: a stored 0.733 must display as
    // "0.733 seconds", never a lossily rounded "0.73 seconds".
    expect(formatSeconds(0.733)).toBe("0.733 seconds");
    expect(formatSeconds(0.15)).toBe("0.15 seconds");
    expect(formatSeconds(0.2)).toBe("0.2 seconds");
    expect(formatSeconds(1)).toBe("1 second");
  });

  it("uses 'second' (singular) only when the value rounds to exactly 1", () => {
    expect(formatSeconds(1)).toBe("1 second");
  });

  it("uses 'seconds' (plural) everywhere else, including 0 and 1.5", () => {
    expect(formatSeconds(0)).toBe("0 seconds");
    expect(formatSeconds(1.5)).toBe("1.5 seconds");
    expect(formatSeconds(2)).toBe("2 seconds");
    expect(formatSeconds(2.5)).toBe("2.5 seconds");
  });

  it("trims trailing zeros (0.730 -> '0.73', 0.20 -> '0.2', 1.00 -> '1')", () => {
    // The Math.round(value * 1000) / 1000 trick + String() coerce both produce
    // a clean fraction with no trailing zeros.
    expect(formatSeconds(0.73)).toBe("0.73 seconds");
    expect(formatSeconds(0.2)).toBe("0.2 seconds");
    expect(formatSeconds(1.0)).toBe("1 second");
    expect(formatSeconds(2.0)).toBe("2 seconds");
  });

  it("preserves up to three decimal places and rounds only at the 4th (no float noise)", () => {
    // 3 decimals are kept exactly; a 4th-decimal input rounds to 3.
    expect(formatSeconds(0.155)).toBe("0.155 seconds");
    expect(formatSeconds(0.733)).toBe("0.733 seconds");
    expect(formatSeconds(0.1234)).toBe("0.123 seconds");
    // No 0.150000000... / 0.7330000001 float-formatting surprises.
    expect(formatSeconds(0.1 + 0.05)).toBe("0.15 seconds");
  });

  it("returns null for null / undefined / non-finite", () => {
    expect(formatSeconds(null)).toBeNull();
    expect(formatSeconds(undefined)).toBeNull();
    expect(formatSeconds(Number.NaN)).toBeNull();
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatSeconds(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Source-grep: the migration widened the column; the form input
// uses step="0.01"; the parser drops int: true; entry-row routes
// through the formatter. Pin each so a future refactor that
// reverts one piece is caught immediately.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("migration 0071 widens thermolysis_duration_seconds to numeric", () => {
  const SQL = read(
    "supabase/migrations/0071_thermolysis_duration_decimal.sql",
  );

  it("alters the column type to numeric", () => {
    expect(SQL).toMatch(
      /alter table public\.electrolysis_entries[\s\S]*alter column thermolysis_duration_seconds type numeric/i,
    );
  });

  it("uses an explicit USING clause for the integer -> numeric coercion", () => {
    expect(SQL).toMatch(
      /using thermolysis_duration_seconds::numeric/i,
    );
  });

  it("does NOT execute DDL on galvanic_duration_seconds (scope decision)", () => {
    // The migration header documents the scope decision (comment
    // text mentions galvanic explicitly) but no SQL statement may
    // touch the galvanic column. Pin the absence of an
    // `alter column galvanic_duration_seconds` clause specifically.
    expect(SQL).not.toMatch(/alter column galvanic_duration_seconds/i);
    expect(SQL).not.toMatch(/add column[\s\S]*galvanic_duration_seconds/i);
  });

  it("does NOT execute DDL on intensity_percent fields", () => {
    expect(SQL).not.toMatch(/alter column[^\n]*intensity_percent/i);
    expect(SQL).not.toMatch(/add column[\s\S]*intensity_percent/i);
  });

  it("documents the verification SQL the operator should run", () => {
    expect(SQL).toMatch(/information_schema\.columns/);
    expect(SQL).toMatch(/numeric_precision/);
    expect(SQL).toMatch(/numeric_scale/);
  });
});

describe("form input + parser accept fractional seconds", () => {
  const FORM = read(
    "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
  );

  it("thermolysis duration input uses step='0.001' (PicoBlend precision, e.g. 0.733s)", () => {
    // Anchor on the surrounding context so we are scoring the
    // thermolysis input, not the galvanic / pulse-count inputs.
    expect(FORM).toMatch(
      /Thermolysis duration \(s\)[\s\S]{0,800}?step="0\.001"/,
    );
  });

  it("thermolysis duration input uses inputMode='decimal' (mobile keyboard)", () => {
    expect(FORM).toMatch(
      /Thermolysis duration \(s\)[\s\S]{0,800}?inputMode="decimal"/,
    );
  });

  it("parser call for thermolysisDurationSeconds does NOT set int: true", () => {
    // The pre-PR call was:
    //   parseOptionalNumber(draft.thermolysisDurationSeconds, {
    //     int: true, min: 0, label: "Thermolysis duration",
    //   })
    // After PR #165 the int: true line must be gone.
    const slice =
      FORM.match(
        /parseOptionalNumber\(draft\.thermolysisDurationSeconds,\s*\{[\s\S]*?\}\)/,
      )?.[0] ?? "";
    expect(slice.length).toBeGreaterThan(0);
    expect(slice).not.toMatch(/int:\s*true/);
  });
});

describe("entry-row display routes thermolysis duration through formatSeconds", () => {
  const ROW = read("components/entry-row.tsx");

  it("imports formatSeconds from the shared helper", () => {
    expect(ROW).toMatch(
      /import \{ formatSeconds \} from "@\/lib\/sessions\/format-seconds"/,
    );
  });

  it("uses formatSeconds(entry.thermolysis_duration_seconds) instead of the bare `${value}s` template", () => {
    expect(ROW).toMatch(
      /formatSeconds\(entry\.thermolysis_duration_seconds\)/,
    );
    // The prior bare template `${entry.thermolysis_duration_seconds}s`
    // must be gone so a regression cannot re-introduce the bug.
    expect(ROW).not.toMatch(
      /\$\{entry\.thermolysis_duration_seconds\}s/,
    );
  });

  it("does NOT use Math.floor / Math.trunc / parseInt on the thermolysis duration value", () => {
    expect(ROW).not.toMatch(
      /(Math\.floor|Math\.trunc|parseInt).*thermolysis_duration_seconds/,
    );
  });
});

describe("PR #162 field order is preserved", () => {
  const FORM = read(
    "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
  );
  it("Thermolysis duration label still appears before Thermolysis intensity label in source", () => {
    const dIdx = FORM.indexOf("Thermolysis duration (s)");
    const iIdx = FORM.indexOf("Thermolysis intensity %");
    expect(dIdx).toBeGreaterThan(-1);
    expect(iIdx).toBeGreaterThan(-1);
    expect(dIdx).toBeLessThan(iIdx);
  });
});

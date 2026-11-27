import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-100. The month picker must not keep a month the page is no longer on. Two things make that true and the browser proof is
// e2e/statements-month-navigation.spec.ts; this pins them so a rewrite cannot drop one without a failing test:
//   * the field is keyed by the month it shows (a new month is a new field), and
//   * autocomplete is off, because the picker submits a plain GET form and the browser otherwise restores the last typed value on Back/Forward.
const src = readFileSync("app/(app)/financials/statements/month-picker-input.tsx", "utf8");

describe("the statements month picker", () => {
  it("is keyed by the month it shows", () => expect(src).toMatch(/<input[^>]*\bkey=\{defaultValue\}/s));
  it("turns browser form restoration off", () => expect(src).toMatch(/<input[^>]*\bautoComplete="off"/s));
});

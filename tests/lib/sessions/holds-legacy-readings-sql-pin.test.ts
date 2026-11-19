import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LEGACY_BLOCK_READING_NUMBER_COLUMNS,
  LEGACY_BLOCK_READING_TEXT_COLUMNS,
  LEGACY_ENTRY_READING_COLUMNS,
  blockHoldsLegacyReadings,
} from "@/lib/sessions/holds-legacy-readings";

// A NON-database pin: the TypeScript twin's column lists must equal the columns named in the SQL function text, so dropping a column from
// either side fails here even where no database is running. The database agreement test (machine-switches.db.test.ts) pins behaviour.

const SQL = readFileSync("docs/proposals/machine-switches.sql", "utf8");
const FN = (() => {
  const i = SQL.indexOf("create or replace function public.block_holds_legacy_readings");
  expect(i).toBeGreaterThan(-1);
  return SQL.slice(i, SQL.indexOf("$$;", SQL.indexOf("as $$", i)) + 3);
})();
const cols = (alias: string, text: string, drop: string[]) =>
  [...new Set([...text.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, "g")).map((m) => m[1])])].filter((c) => !drop.includes(c)).sort();

describe("the TypeScript twin matches the SQL function text", () => {
  it("block columns", () => {
    expect(cols("b", FN, ["id"])).toEqual([...LEGACY_BLOCK_READING_TEXT_COLUMNS, ...LEGACY_BLOCK_READING_NUMBER_COLUMNS].sort());
  });
  it("entry columns", () => {
    expect(cols("e", FN, ["block_id", "deleted_at"])).toEqual([...LEGACY_ENTRY_READING_COLUMNS].sort());
  });
  it("the SQL skips soft-deleted entries and so does the twin", () => {
    expect(FN).toMatch(/e\.deleted_at is null/);
    expect(blockHoldsLegacyReadings(null, [{ thermolysis_intensity_percent: 30, deleted_at: "2026-01-01" }])).toBe(false);
  });
  it("the block's mode and sticky frequency are in neither", () => {
    expect(FN).not.toMatch(/\bb\.(mode|machine_frequency)\b/);
    expect(blockHoldsLegacyReadings({ mode: "thermo", machine_frequency: "27.12 MHz" }, [])).toBe(false);
  });
  it("entry energy level and modality are in both (dropping either from the twin must fail)", () => {
    expect(LEGACY_ENTRY_READING_COLUMNS).toContain("energy_level");
    expect(LEGACY_ENTRY_READING_COLUMNS).toContain("apilus_modality");
    expect(FN).toMatch(/e\.energy_level is not null/);
  });
});

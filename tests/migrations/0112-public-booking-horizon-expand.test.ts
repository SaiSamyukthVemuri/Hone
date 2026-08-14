import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0112_public_booking_horizon_expand.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0112: number", () => {
  it("is migration 0112 (repo-max tripwire now lives in the newest migration test, 0113)", () => {
    expect(FILE).toMatch(/^0112_/);
  });
});

describe("0112: widen public_booking_horizon_months CHECK to 1..12", () => {
  it("replaces the CHECK with the full 1..12 allowlist", () => {
    expect(SQL).toMatch(/drop constraint if exists studios_public_booking_horizon_months_check/);
    expect(SQL).toMatch(
      /check \(public_booking_horizon_months in \(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12\)\)/,
    );
  });
  it("keeps the existing 3/4/6 values valid (subset of 1..12)", () => {
    for (const v of [3, 4, 6]) {
      expect(SQL).toMatch(new RegExp(`\\b${v}\\b`));
    }
  });
  it("does NOT allow 0 or 13 (bounds: min 1 month, max 12 months)", () => {
    const list = /in \(([^)]*)\)/.exec(SQL)?.[1] ?? "";
    const nums = list.split(",").map((s) => Number(s.trim()));
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(nums).not.toContain(0);
    expect(nums).not.toContain(13);
  });
  it("is additive only: no column add/drop, no default change, no data backfill, no RLS/policy", () => {
    expect(SQL).not.toMatch(/add column|drop column|drop table/i);
    expect(SQL).not.toMatch(/set default|alter column/i); // default (3) untouched
    expect(SQL).not.toMatch(/update public\.studios set/i);
    expect(SQL).not.toMatch(/create policy|drop policy|alter policy/i);
  });
});

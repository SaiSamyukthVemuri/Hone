import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0153_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");

describe("0153 — services.calendar_color (additive, CHECK-constrained, no rose)", () => {
  it("is present and 0152 precedes it; nothing 0155+ yet", () => {
    expect(FILE).toMatch(/^0153_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0152_"))).toBe(true);
    // 0154 (card-change notification dedupe_key) now exists; guard forward of it.
    expect(files.filter((f) => /^01(5[8-9]|[6-9]\d)_/.test(f))).toEqual([]);
  });
  it("adds calendar_color, defaults it, sets NOT NULL, and CHECK-constrains to the six allowed keys", () => {
    expect(SQL).toMatch(/add column if not exists calendar_color text/);
    expect(SQL).toMatch(/alter column calendar_color set default 'sky'/);
    expect(SQL).toMatch(/alter column calendar_color set not null/);
    expect(SQL).toMatch(/check \(calendar_color in \('amber','emerald','teal','sky','indigo','violet'\)\)/);
  });
  it("excludes rose/red and any arbitrary CSS/class strings", () => {
    expect(SQL).not.toMatch(/'rose'|'red'|bg-|text-|border-/);
  });
  it("backfills existing rows deterministically and rewrites NO appointment rows / identity / pricing", () => {
    expect(SQL).toMatch(/update public\.services\s*\n\s*set calendar_color =/);
    // Deterministic per-service default; hashtext (int4) MUST be cast to bigint
    // before abs() so abs(int4 min) never overflows.
    expect(SQL).toMatch(/abs\(hashtext\([^)]*\)::bigint\)/);
    expect(SQL).not.toMatch(/abs\(hashtext\([^)]*\)\) %/); // reject the un-cast form
    const body = SQL.slice(0, SQL.indexOf("\ncommit;") + 1);
    expect(body).not.toMatch(/update public\.appointments/i);
    expect(body).not.toMatch(/price_cents|drop table|drop column/i);
  });
  it("is transactional", () => {
    expect(SQL).toMatch(/^\s*begin;/m);
    expect(SQL).toMatch(/\ncommit;/);
  });
});

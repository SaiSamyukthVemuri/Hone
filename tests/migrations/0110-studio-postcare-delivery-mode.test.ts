import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0110_studio_postcare_delivery_mode.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0110: number", () => {
  it("is migration 0110 (repo-max tripwire now lives in the newest migration test, 0111)", () => {
    expect(FILE).toMatch(/^0110_/);
  });
});

describe("0110: studios.postcare_delivery_mode", () => {
  it("adds a text column defaulting to 'manual' (safe by default; no studio hardcoded)", () => {
    expect(SQL).toMatch(
      /add column if not exists postcare_delivery_mode text not null default 'manual'/,
    );
  });
  it("constrains to manual or auto_on_complete", () => {
    expect(SQL).toMatch(/postcare_delivery_mode in \('manual', 'auto_on_complete'\)/);
    expect(SQL).toMatch(/studios_postcare_delivery_mode_check/);
  });
  it("is additive only: no drop, no policy, no data backfill, no new appointment column", () => {
    expect(SQL).not.toMatch(/drop column/i);
    expect(SQL).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(SQL).not.toMatch(/update public\.studios set/i);
    expect(SQL).not.toMatch(/alter table public\.appointments/i);
  });
});

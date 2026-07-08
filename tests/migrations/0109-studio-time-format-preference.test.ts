import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0109_studio_time_format_preference.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0109 — number (repo-max tripwire)", () => {
  it("is the repo migration max", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    expect(maxNum).toBe(109);
    expect(FILE).toMatch(/^0109_/);
  });
});

describe("0109 — studios.time_format_preference", () => {
  it("adds a text column defaulting to 12h (existing studios → 12h; no studio hardcoded)", () => {
    expect(SQL).toMatch(
      /add column if not exists time_format_preference text not null default '12h'/,
    );
  });
  it("constrains the value to 12h or 24h", () => {
    expect(SQL).toMatch(/time_format_preference in \('12h', '24h'\)/);
    expect(SQL).toMatch(/studios_time_format_preference_check/);
  });
  it("is additive only — no drop, no policy change, no data backfill/update", () => {
    expect(SQL).not.toMatch(/drop column/i);
    expect(SQL).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(SQL).not.toMatch(/update public\.studios set/i);
  });
});

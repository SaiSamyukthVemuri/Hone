import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0102 adds electrolysis_entries.pulse_delay_seconds (the delay
// between high-frequency pulses, recorded only when pulse_count > 1). Additive,
// nullable, with a range CHECK (0.03–1.90). Source-grep the shape; the CHECK
// behavior is exercised on the real DB by tests/db/pulse-delay.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0102_electrolysis_entry_pulse_delay.sql";
const SOURCE = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const CODE = SOURCE.replace(/--.*$/gm, "");

describe("0102: migration number + scope", () => {
  it("is numbered 0102 (immediately after 0101)", () => {
    const nums = readdirSync(MIGRATIONS_DIR)
      .map((f) => /^(\d{4})_/.exec(f)?.[1])
      .filter(Boolean)
      .map((n) => Number(n));
    // 0102 exists and 0101 precedes it; the global-max tripwire lives in the
    // newest migration's test, so this does not re-break when later
    // migrations land.
    expect(nums).toContain(102);
    expect(nums).toContain(101);
    expect(FILE).toMatch(/^0102_/);
  });

  it("touches ONLY electrolysis_entries (no other table / RLS / env)", () => {
    expect(CODE).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(CODE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE|stripe/i);
    expect(CODE).not.toMatch(/alter table public\.(?!electrolysis_entries)/i);
  });
});

describe("0102: additive nullable column + range CHECK", () => {
  it("adds pulse_delay_seconds numeric(4,2), nullable, if not exists", () => {
    expect(CODE).toMatch(
      /add column if not exists\s+pulse_delay_seconds\s+numeric\(4,\s*2\)/i,
    );
    // Additive only — no NOT NULL, no default, no backfill.
    expect(CODE).not.toMatch(/pulse_delay_seconds[^;]*not null/i);
    expect(CODE).not.toMatch(/update public\.electrolysis_entries/i);
  });

  it("bounds a non-null value to [0.03, 1.90] but always allows NULL", () => {
    expect(CODE).toMatch(
      /add constraint\s+electrolysis_entries_pulse_delay_seconds_range_check/i,
    );
    expect(CODE).toMatch(
      /check\s*\(\s*pulse_delay_seconds is null\s+or\s*\(\s*pulse_delay_seconds >= 0\.03 and pulse_delay_seconds <= 1\.90\s*\)\s*\)/i,
    );
  });

  it("does NOT alter pulse_count or any other reading column (DDL only)", () => {
    // The descriptive `comment on column` mentions pulse_count; strip it so the
    // grep targets real DDL, not prose.
    const ddl = CODE.replace(/comment on column[\s\S]*?;/gi, "");
    expect(ddl).not.toMatch(/(alter|add|drop)\s+column[^;]*pulse_count/i);
    expect(ddl).not.toMatch(
      /(alter|add|drop)\s+column[^;]*(hairs_treated|intensity|thermolysis|galvanic)/i,
    );
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #280. SQL-text pin for migration 0096 (disinfectant discard/replace-by
// date). Behavioral proof is in tests/db/record-keeping-discard-due.db.test.ts.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0096_disinfectant_discard_due_date.sql"),
  "utf8",
);

describe("0096 adds discard_due_date (additive, idempotent)", () => {
  it("adds the nullable date column if not exists", () => {
    expect(SQL).toMatch(
      /alter table public\.record_keeping_disinfectants[\s\S]*add column if not exists discard_due_date date/,
    );
  });
  it("includes a preflight note", () => {
    expect(SQL).toMatch(/PREFLIGHT/);
  });
});

describe("0096 changes nothing else (no cron/notification/RLS/payment)", () => {
  // Negatives run against executable SQL only — the header comment legitimately
  // mentions "notification" / "cron" to document what is deliberately deferred.
  const CODE = SQL.split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  it("only touches record_keeping_disinfectants", () => {
    const alters = CODE.match(/alter table\s+public\.[a-z_]+/gi) ?? [];
    for (const a of alters) {
      expect(a.toLowerCase()).toBe("alter table public.record_keeping_disinfectants");
    }
  });
  it("adds no reminder marker, notification, cron, RLS, or backfill (executable SQL)", () => {
    expect(CODE).not.toMatch(/discard_reminder_sent_at|reminder_sent/i);
    expect(CODE).not.toMatch(/practitioner_notifications|notification/i);
    expect(CODE).not.toMatch(/create policy|drop policy|row level security/i);
    expect(CODE).not.toMatch(/\bupdate\s+public\./i);
    expect(CODE).not.toMatch(/paymentIntents|stripe/i);
  });
});

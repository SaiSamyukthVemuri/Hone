import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0313 — waitlist booking command. Behaviour is proved against a real database
// in tests/db/waitlist-booking-command.db.test.ts. This file pins the held
// rollback file.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const DOWN = read("supabase/rollbacks/0313_waitlist_booking_command.down.sql");
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

describe("0313 — held rollback", () => {
  it("refuses while follow-up rows exist, then drops the objects", () => {
    expect(DOWN).toMatch(/errcode = '55000'/);
    expect(DOWN).toMatch(/drop table if exists public\.waitlist_invitation_followups;/);
    expect(DOWN).toMatch(/not a migration|NOT a migration/);
  });

  it("the held down file drops the link table too", () => {
    expect(exec(DOWN)).toMatch(/drop table if exists public\.waitlist_invitation_bookings;/);
  });
});

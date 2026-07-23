import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maxPublicBookingHorizonDays } from "@/lib/booking/horizon";

// PR B 3E-3 — one recurring-break materialization horizon = the max public
// booking horizon + 14 days margin, used by EVERY writer (owner create/update/
// toggle actions, cron, and the DB timezone rebuild). Fails if the supported
// horizon changes without the SQL helper being updated in lockstep.

const HORIZON = maxPublicBookingHorizonDays() + 14;

const ACTIONS = readFileSync(
  join(process.cwd(), "app/(app)/settings/availability/actions.ts"),
  "utf8",
);
const MIG = readFileSync(
  join(process.cwd(), "supabase/migrations/0138_scoped_sources_lock_and_dormancy.sql"),
  "utf8",
);

describe("recurring-break horizon is unified at max public horizon + 14", () => {
  it("the value is 386 (12*31 + 14)", () => {
    expect(HORIZON).toBe(386);
  });

  it("the SQL helper matches the TS maximum + margin", () => {
    // recurring_break_horizon_days() must return exactly the TS horizon.
    const m = MIG.match(/recurring_break_horizon_days\(\)[\s\S]*?select (\d+)/i);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(HORIZON);
    // The timezone rebuild uses the helper, not the old 90.
    expect(MIG).toMatch(/\+ public\.recurring_break_horizon_days\(\)/);
    expect(MIG).not.toMatch(/::date\) \+ 90\b/);
  });

  it("the owner actions derive from maxPublicBookingHorizonDays (no stale 186)", () => {
    expect(ACTIONS).toMatch(/maxPublicBookingHorizonDays\(\) \+ 14/);
    expect(ACTIONS).not.toMatch(/setUTCDate\([^)]*\+ 186\)/);
  });
});

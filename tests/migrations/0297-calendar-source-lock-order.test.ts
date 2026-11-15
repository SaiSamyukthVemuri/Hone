import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0297 calendar source lock order (HON-48, SQLSTATE 40P01): source contract. Behaviour is proved in
// tests/db/calendar-source-lock-order.db.test.ts (catalog lock-order audit, deterministic cycle tests, randomised races) and in
// tests/db/simultaneous-booking-block-race.db.test.ts with KNOWN_DEFECT_HON48_DEADLOCK = false. No repo-max pin (CLAUDE.md section 2).
const FILE = "supabase/migrations/0297_calendar_source_lock_order.sql";
const sql = readFileSync(FILE, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const body = (name: string) => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;|create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`, "i"));
  expect(m, name).not.toBeNull();
  return m![0].toLowerCase();
};
const ORDERED = [
  "lock_structural_calendar_source_mutation",
  "materialize_recurring_break_rule",
  "create_recurring_break_rule_and_materialize",
  "update_recurring_break_rule_and_rematerialize",
  "delete_recurring_break_rule",
];

describe("0297: shape", () => {
  it("owns one filename, opens its own transaction with lock_timeout inside, and changes no table, column, policy or trigger and runs no data statement", () => {
    expect(countVersion("0297")).toBe(1);
    expect(fileForVersion("0297")).toBe("0297_calendar_source_lock_order.sql");
    expect(code.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(code.trim()).toMatch(/commit;$/);
    // Function bodies legitimately contain insert/update/delete (the break-rule commands); only DDL and data statements OUTSIDE a body count.
    const outsideBodies = code.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "");
    expect(outsideBodies).not.toMatch(/\b(insert\s+into|delete\s+from|truncate|alter\s+table|create\s+table|drop\s+|create\s+policy|create\s+(or replace\s+)?trigger|update\s+public\.)/i);
  });

  it("every function takes the studios row FOR NO KEY UPDATE before the advisory lock, and never FOR UPDATE", () => {
    for (const name of [...ORDERED, "on_practitioner_change_refan"]) {
      const b = body(name);
      const row = b.search(/from\s+public\.studios\s+s\s+where[^;]*for no key update/);
      const adv = b.search(/acquire_studio_capacity_lock|rematerialize_studio_reservations/);
      expect(row, `${name}: studios row lock present`).toBeGreaterThan(-1);
      expect(adv, `${name}: reaches the capacity lock`).toBeGreaterThan(-1);
      expect(row, `${name}: studios row before the capacity lock`).toBeLessThan(adv);
      expect(b, `${name}: no FOR UPDATE on the studios row`).not.toMatch(/from\s+public\.studios[^;]*for\s+update\b/);
    }
  });

  it("the practitioner-change trigger locks both studios in id order on a move and takes no lock for a capacity-off studio", () => {
    const b = body("on_practitioner_change_refan");
    expect(b).toMatch(/s\.id in \(old\.studio_id, new\.studio_id\) order by s\.id for no key update/);
    expect(b).toMatch(/studio_capacity_enabled\(old\.studio_id\)/);
  });

  it("the block trigger function revokes EXECUTE by name from public, anon, authenticated and service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toMatch(new RegExp(`revoke execute on function public\\.lock_structural_calendar_source_mutation\\(\\) from ${role};`));
    }
  });

  it("is security definer with a fixed search_path for every replaced function", () => {
    for (const name of [...ORDERED, "on_practitioner_change_refan"]) {
      const b = body(name);
      expect(b, name).toMatch(/security definer/);
      expect(b, name).toMatch(/set search_path (to |= )'?pg_catalog'?, '?pg_temp'?/);
    }
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 — migration 0142 (canonical internal booking command). Structural
// contract: atomic, service_role-only, correct lock order, booking-pause gate,
// capacity-gated eligibility, no raw exception leakage. Behaviour is proven in
// tests/db/internal-booking-command.db.test.ts.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0142_internal_booking_command.sql"),
  "utf8",
);
const CODE = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const idx = (n: string) => SQL.indexOf(n);
const SIG =
  "public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text)";

describe("0142 — atomic + service_role-only", () => {
  it("wraps the whole migration in one begin;/commit;", () => {
    const first = CODE.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    expect(first).toBe("begin;");
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("defines create_internal_appointment and locks it to service_role", () => {
    expect(SQL).toMatch(/create or replace function public\.create_internal_appointment\(/);
    expect(SQL).toContain(`revoke execute on function ${SIG} from public;`);
    expect(SQL).toContain(`revoke execute on function ${SIG} from anon;`);
    expect(SQL).toContain(`revoke execute on function ${SIG} from authenticated;`);
    expect(SQL).toContain(`grant execute on function ${SIG} to service_role;`);
  });

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
  });
});

describe("0142 — the transaction contract", () => {
  it("locks the studios ROW (for update) BEFORE taking the advisory lock (0138 order)", () => {
    const forUpdate = idx("for update");
    const advisory = idx("acquire_studio_capacity_lock");
    expect(forUpdate).toBeGreaterThan(0);
    expect(advisory).toBeGreaterThan(0);
    expect(forUpdate).toBeLessThan(advisory);
  });

  it("gates new creation when capacity is ON but booking is OFF (paused)", () => {
    expect(SQL).toMatch(/if v_cap and not v_book then/);
    expect(SQL).toMatch(/booking_paused/);
  });

  it("enforces member-self-only and same-studio + eligibility (eligibility only when capacity ON)", () => {
    expect(SQL).toMatch(/v_actor_role <> 'owner'/);
    expect(SQL).toMatch(/not_authorized/);
    // eligibility check is guarded by v_cap
    expect(SQL).toMatch(/if v_cap and not exists \(\s*select 1 from public\.service_practitioners/);
    expect(SQL).toMatch(/not_eligible/);
  });

  it("computes the interval server-side and inserts status='confirmed' (never trusts a caller end)", () => {
    expect(SQL).toMatch(/v_ends_at := p_starts_at \+ make_interval\(mins => p_duration_minutes\)/);
    expect(SQL).toMatch(/'confirmed'/);
    // returns a closed result-code set; never RAISEs raw detail to the caller.
    expect(SQL).not.toMatch(/raise exception/i);
  });
});

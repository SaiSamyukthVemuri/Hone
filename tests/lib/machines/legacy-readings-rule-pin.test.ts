import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Insurance LK-5 (#1369): the page decides whether an area "holds legacy readings" from the entries it loads, and 0301 decides it from
// the entries in the database. The two lists must follow ONE rule: live (not deleted) readings. A soft-deleted entry is not a reading
// to either. If one side changes, this fails and the other must be looked at.
const read = (p: string) => readFileSync(p, "utf8");

describe("the page and 0301 count the same readings: live (not deleted) ones", () => {
  it("the page loads only live entries (migration 0114 voided passes are excluded)", () => {
    const q = read("lib/supabase/queries.ts");
    const at = q.indexOf('.from("electrolysis_entries")');
    expect(at).toBeGreaterThan(-1);
    expect(q.slice(at, at + 260)).toMatch(/\.is\("deleted_at", null\)/);
  });
  it("0301's legacy-readings read ignores soft-deleted entries", () => {
    const m = read("supabase/migrations/0301_session_block_machine_identity.sql");
    const at = m.indexOf("from public.electrolysis_entries e");
    expect(at).toBeGreaterThan(-1);
    expect(m.slice(at, at + 260)).toMatch(/e\.deleted_at is null/);
  });
  it("both read the same entry columns the host's lock lists", () => {
    const host = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
    const m = read("supabase/migrations/0301_session_block_machine_identity.sql");
    for (const col of ["thermolysis_intensity_percent", "thermolysis_duration_seconds", "galvanic_ma", "galvanic_duration_seconds", "units_of_lye"]) {
      expect(host, `host lock lists ${col}`).toContain(`firstEntry?.${col} != null`);
      expect(m, `0301 lists ${col}`).toContain(`e.${col} is not null`);
    }
  });
});

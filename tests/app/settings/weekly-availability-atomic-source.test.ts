import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 Item 2, the full-week availability writers route through the atomic,
// lock-taking RPC (no per-day loop of independent upserts).

const ACTIONS = readFileSync(
  join(process.cwd(), "app/(app)/settings/availability/actions.ts"),
  "utf8",
);

describe("full-week availability save: atomic RPC wiring", () => {
  it("saveWeeklyDefaultsAction calls save_weekly_availability with a NULL studio-wide scope", () => {
    expect(ACTIONS).toMatch(/save_weekly_availability/);
    expect(ACTIONS).toMatch(/p_scope_practitioner_id: null/);
    // The old per-day loop of independent upserts is gone.
    expect(ACTIONS).not.toMatch(/for \(const row of rows\)/);
  });
  it("customizePractitionerWeekAction routes the practitioner scope through the same RPC", () => {
    expect(ACTIONS).toMatch(/p_scope_practitioner_id: scope\.practitionerId/);
  });
  it("both use the admin (service_role) client after a server-side owner check", () => {
    expect(ACTIONS).toMatch(/createAdminClient\(\)/);
    expect(ACTIONS).toMatch(/assertOwner\(\)/);
  });
});

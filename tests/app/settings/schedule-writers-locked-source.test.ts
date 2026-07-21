import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 Item 2 — the single-row schedule writers route through the locked
// admin RPCs (migration 0150). This guard prevents a regression back to a direct
// browser-role upsert/delete on the protected availability tables (which would
// bypass the studios-row + capacity advisory lock).

const AVAIL = readFileSync(
  join(process.cwd(), "app/(app)/settings/availability/actions.ts"),
  "utf8",
);
const TEAM = readFileSync(
  join(process.cwd(), "app/(app)/settings/team/actions.ts"),
  "utf8",
);

describe("schedule writers — locked-command wiring", () => {
  it("availability actions never write the protected tables directly", () => {
    for (const table of ["studio_availability_default", "studio_availability_overrides"]) {
      // The table name may still appear in a SELECT, but never followed by an
      // upsert/delete within the same chain.
      const writeChain = new RegExp(`${table}"\\)[\\s\\S]{0,120}?\\.(upsert|delete)\\(`);
      expect(AVAIL).not.toMatch(writeChain);
    }
  });
  it("availability actions route every single-row write through a locked RPC", () => {
    for (const fn of [
      "upsert_availability_day_locked",
      "delete_availability_day_locked",
      "upsert_availability_override_locked",
      "delete_availability_override_locked",
    ]) {
      expect(AVAIL).toContain(fn);
    }
    expect(AVAIL).toMatch(/p_actor_practitioner_id:/);
  });
  it("removePractitionerAction uses the locked command, not a raw active=false or leaked error", () => {
    expect(TEAM).toMatch(/set_practitioner_active_locked/);
    expect(TEAM).not.toMatch(/\.update\(\{ active: false \}\)/);
    // No raw DB message in the deactivation path.
    expect(TEAM).not.toMatch(/Failed to (look up|remove) practitioner: \$\{/);
  });
});

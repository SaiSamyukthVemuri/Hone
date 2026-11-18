import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileForVersion } from "./helpers/migration-state";
import { EXPORT_RESOURCE_REGISTRY } from "@/lib/export/resource-registry";

// 0192 — WAIT-03B recipient-proof authority (applied, frozen). This pins the
// live export registry to the tables the migration creates.

const VERSION = "0192";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(
  path.resolve(__dirname, "../../supabase/migrations", FILE),
  "utf8",
);

// Executable SQL only.
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

describe("0192 — every table it creates has an EXPORT DISPOSITION on the record", () => {
  // WHY THIS LIVES HERE AND NOT ONLY IN tests/db.
  //
  // The export registry guard is real and it works — it is what caught this
  // omission. But it can only run in the db-integration lane, because it
  // introspects information_schema on a fully migrated stack. That lane is the
  // slowest one in CI, so a migration that adds a table and forgets its
  // disposition stays green through typecheck, lint, unit and the whole
  // migrations suite, and only goes red minutes later in db-integration.
  //
  // That is exactly how e038d1e8 was pushed red: the local run covered the
  // waitlist DB files and the full unit suite, and neither could see this.
  //
  // This assertion closes the loop in the FAST lane. It derives the table list
  // from the migration TEXT rather than hard-coding it, so a future table added
  // to this file is covered without anyone remembering to extend the test.
  const created = [
    ...CODE.matchAll(/create table if not exists\s+public\.(\w+)/g),
  ].map((m) => m[1]);

  it("every created table has a disposition — a missing one is a BUILD failure, not a discovery", () => {
    for (const table of created) {
      const disposition = EXPORT_RESOURCE_REGISTRY[table];
      expect(
        disposition,
        `${table} is created by 0192 but has no entry in EXPORT_RESOURCE_REGISTRY. ` +
          `Nothing is allowed to reach the database without someone deciding whether ` +
          `a departing studio gets it.`,
      ).toBeDefined();
      expect(["exported", "excluded", "pending"]).toContain(disposition.kind);
    }
  });

  it("the round table is PENDING, with a ticket and a tier — never silently EXPORTED or EXCLUDED", () => {
    const d = EXPORT_RESOURCE_REGISTRY["studio_waitlist_admission_rounds"];
    // PINS THE DISPOSITION. Promoting this table to `exported` is a payload
    // change and must be a deliberate, reviewed act; demoting it to `excluded`
    // would hide an owner's own admission decision from a departing studio.
    // Either would flip this assertion, which is the point.
    expect(d.kind).toBe("pending");
    if (d.kind !== "pending") throw new Error("unreachable: narrowed above");
    // A pending entry that carries no ticket is a gap kept quiet, which is the
    // exact failure the registry exists to prevent.
    expect(d.ticket).toBeTruthy();
    expect(d.tier).toBeTypeOf("number");
    expect(d.reason.length).toBeGreaterThan(80);
    // Not field-review-required, and that is a CLAIM about the row: three
    // columns, no security material, no provider identifier, no attribution.
    // If a later slice adds such a column here, this must be revisited.
    expect(d.fieldReviewRequired ?? false).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ONE byte version of the held migration 0287 exists across #1340, #1341, #1335 and #1342, owned by #1340 (OPS, Insurance RM-1 / Privacy T1).
// A branch stacked on #1340 must not modify it. If you are changing 0287 on #1340 itself, update this digest in the same commit and tell every
// stacked branch to merge forward; on any other branch a red here means the migration was edited in the wrong place.
const OWNED_BY_1340_SHA256 = "0627fddb629496dad28f715ace670d204b0d2194989df278861029f14a3d1747";

describe("0287 has exactly one byte version", () => {
  it("is byte-identical to the version owned by #1340", () => {
    const bytes = readFileSync("supabase/migrations/0287_roles_permission_engine.sql");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(OWNED_BY_1340_SHA256);
  });
});

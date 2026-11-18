import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Kept as the migration-test reader of the capability manifest: the change
// classifier's dependency scan (tests/ci/classify-changes.test.ts) names this
// file as the real edge that proves a docs JSON edit selects its reader.
describe("0160 — capability manifest", () => {
  it("the capability manifest reports the corrected hosted max", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "docs/roadmap/CAPABILITY_MANIFEST.json"), "utf8"),
    );
    expect(
      manifest.hosted_migration_max,
      "the manifest's hosted_migration_max is a current-state field and must read 0160",
    ).toBe("0160");
    expect(manifest.as_of).toBe("2026-07-30");
  });
});

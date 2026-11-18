import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Kept as a migration-test reader of the migration ledger: the change
// classifier's dependency scan (tests/ci/classify-changes.test.ts) names this
// file as the real edge that proves a ledger edit selects its reader.

const LEDGER = readFileSync(
  join(__dirname, "..", "..", "docs/production/migration-ledger.md"),
  "utf8",
);

/** The FROZEN 0179 rollout entry — 0179's permanent apply record. */
const ENTRY_0179 = (() => {
  const HEAD = "## 0179 — ACTOR FK INTEGRITY";
  const i = LEDGER.indexOf(HEAD);
  if (i === -1) {
    // Fail loudly. Silently falling back to other ledger content would let
    // permanent assertions pass against an unrelated migration's entry.
    throw new Error(
      "migration-ledger.md has no '## 0179 — ACTOR FK INTEGRITY' entry; 0179's permanent apply evidence is missing",
    );
  }
  const rest = LEDGER.slice(i + HEAD.length);
  const next = rest.search(/\n## /);
  return next === -1 ? LEDGER.slice(i) : LEDGER.slice(i, i + HEAD.length + next);
})();

describe("0179 — the frozen ledger entry", () => {
  it("records the census and the documented partial closure", () => {
    expect(ENTRY_0179).toMatch(/39 changed \+ 25 unchanged \+/);
    expect(ENTRY_0179).toMatch(/MATCH SIMPLE/);
    expect(ENTRY_0179).toMatch(/electrolysis_entries\.deleted_by/);
  });
});

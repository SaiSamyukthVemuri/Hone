import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Privacy EH-4. The export reads session_blocks through an EXPLICIT column list
// (app/(app)/settings/data/actions.ts). Migration 0301 adds three columns, so
// the decision must be written down: they are NOT in that list, and the
// registry says so by name, so a later reader finds the gap rather than
// assuming coverage.
const root = path.resolve(__dirname, "../../..");
const REGISTRY = readFileSync(path.join(root, "lib/export/resource-registry.ts"), "utf8");
const ACTIONS = readFileSync(path.join(root, "app/(app)/settings/data/actions.ts"), "utf8");

describe("session_blocks machine identity and the studio export", () => {
  it("the export's block column list does not include the identity columns", () => {
    for (const col of ["machine_profile_id", "studio_machine_id", "machine_mode_key"]) {
      expect(ACTIONS).not.toContain(col);
    }
  });
  it("the pending session_blocks entry names all three columns as not exported", () => {
    const at = REGISTRY.indexOf("  session_blocks: {");
    const entry = REGISTRY.slice(at, REGISTRY.indexOf("  session_block_areas: {", at));
    for (const col of ["machine_profile_id", "studio_machine_id", "machine_mode_key"]) {
      expect(entry, col).toContain(col);
    }
    expect(entry).toMatch(/kind: "pending"/);
  });
});

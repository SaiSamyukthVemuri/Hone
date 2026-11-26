import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { exportedResources } from "@/lib/export/resource-registry";

// The export reads session_blocks through an EXPLICIT column list
// (app/(app)/settings/data/actions.ts). Migration 0301 adds three columns, so
// the decision must be written down: they are NOT in that list, and the
// registry says so by name, so a later reader finds the gap rather than
// assuming coverage.
const root = path.resolve(__dirname, "../../..");
const REGISTRY = readFileSync(path.join(root, "lib/export/resource-registry.ts"), "utf8");
const ACTIONS = readFileSync(path.join(root, "app/(app)/settings/data/actions.ts"), "utf8");

describe("session_blocks machine identity and the studio export", () => {
  // The export READS the identity columns from session_blocks for one reason: a native (MultiPlex) area's legacy pulse_count is the database default,
  // so the CSV leaves it blank, decided by the shared isNativeMachineBlock rule (the existing xCell workflow keeps its pulse count). The identity
  // columns are never EMITTED from session_blocks: with ONE exception, no exported file has them as a header, and the exception is
  // treatment_setup_readings, whose own rows carry the unit and profile a reading was recorded under (they are that table's columns, not
  // session_blocks'). machine_mode_key is not a column of any exported file.
  it("the identity columns are never EMITTED by the export, except as the readings file's own columns", () => {
    for (const col of ["machine_profile_id", "studio_machine_id", "machine_mode_key"]) {
      for (const r of exportedResources()) {
        if (r.resource === "treatment_setup_readings" && col !== "machine_mode_key") continue;
        expect(r.disposition.csvHeaders, `${r.resource} header ${col}`).not.toContain(col);
      }
    }
    const readings = exportedResources().find((r) => r.resource === "treatment_setup_readings")!;
    expect(readings.disposition.csvHeaders).toContain("machine_profile_id");
    expect(readings.disposition.csvHeaders).toContain("studio_machine_id");
    const code = ACTIONS.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const uses = (col: string) => code.match(new RegExp(`.*${col}.*`, "g")) ?? [];
    // the block select, the row type, and (for the two that readings carry) the readings select; studio_machine_id is also named by the one line that
    // blanks it for the unspecified-machine placeholder, migration 0385 (studio_machines.is_unspecified), which is why it is 4 and not 3.
    expect(uses("machine_profile_id").length, uses("machine_profile_id").join(" | ")).toBe(3);
    expect(uses("studio_machine_id").length, uses("studio_machine_id").join(" | ")).toBe(4);
    expect(uses("machine_mode_key").length, uses("machine_mode_key").join(" | ")).toBe(2);
    expect(code).toMatch(/pulse_count: isNativeMachineBlock\(b\) \? null : e\.pulse_count/);
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

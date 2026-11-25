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
  // the export now READS machine_profile_id from session_blocks, for one reason: a native (MultiPlex) area's legacy pulse_count is the database
  // default, so the CSV leaves it blank. The guard's purpose is that the identity columns are never EMITTED, so it now pins that: no identity column
  // is a CSV header of any exported file, studio_machine_id and machine_mode_key are not read at all, and machine_profile_id appears only in the
  // block read and the pulse_count expression.
  // The export READS the identity columns from session_blocks for one reason: a native (MultiPlex) area's legacy pulse_count is the database default,
  // so the CSV leaves it blank, decided by the shared isNativeMachineBlock rule (the existing xCell workflow keeps its pulse count). The guard's
  // purpose is that the identity columns are never EMITTED: no exported file has them as a header, and they appear only in the block read, its row
  // type and the pulse_count blanking.
  it("the identity columns are never EMITTED by the export", () => {
    for (const col of ["machine_profile_id", "studio_machine_id", "machine_mode_key"]) {
      for (const r of exportedResources()) {
        expect(r.disposition.csvHeaders, `${r.resource} header ${col}`).not.toContain(col);
      }
    }
    const code = ACTIONS.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    for (const col of ["machine_profile_id", "studio_machine_id", "machine_mode_key"]) {
      const uses = code.match(new RegExp(`.*${col}.*`, "g")) ?? [];
      expect(uses.length, `${col}: ${uses.join(" | ")}`).toBe(col === "machine_profile_id" ? 2 : 2); // the block select, the row type
    }
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

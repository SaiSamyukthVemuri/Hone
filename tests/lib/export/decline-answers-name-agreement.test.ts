import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { exportSpec, exportedResources } from "@/lib/export/resource-registry";

// Privacy A1. The answers file is named in THREE places that nothing else ties together: the audit command's file map (0325, which replaces
// 0242's), the registry entry, and the exporter. If they drift, the audit command returns false and every studio export fails at the last step.
const RESOURCE = "waitlist_decline_answers";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** The map of the NEWEST migration that defines record_studio_export_audit_governed. */
function newestAuditMap(): { file: string; map: Record<string, string> } {
  const dir = join(process.cwd(), "supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.reverse()) {
    const sql = readFileSync(join(dir, f), "utf8");
    if (!/create (or replace )?function public\.record_studio_export_audit_governed\(/.test(sql)) continue;
    const raw = sql.match(/\$registry\$([\s\S]*?)\$registry\$/)?.[1];
    if (raw) return { file: f, map: JSON.parse(raw) as Record<string, string> };
  }
  throw new Error("no migration defines the export audit map");
}

describe("the decline answers file is named identically in the audit map, the registry and the exporter", () => {
  const { file: migration, map } = newestAuditMap();
  const spec = exportSpec(RESOURCE);
  const actions = read("app/(app)/settings/data/actions.ts");

  it("the newest audit map is the one that carries it (0325 or later)", () => {
    expect(Number(migration.slice(0, 4))).toBeGreaterThanOrEqual(325);
  });
  it("the audit map and the registry agree on the file name, under the same resource key", () => {
    expect(map[RESOURCE]).toBe("waitlist-decline-answers.csv");
    expect(spec.file).toBe(map[RESOURCE]);
  });
  it("the audit map is exactly the registry's exported resources, nothing more or less", () => {
    expect(map).toEqual(Object.fromEntries(exportedResources().map(({ resource, disposition }) => [resource, disposition.file])));
  });
  it("the exporter writes the file under the resource key, and takes its name from the registry, never a literal", () => {
    expect(actions).toContain(`writeCsv("${RESOURCE}", declineAnswersRes)`);
    expect(actions).not.toContain("waitlist-decline-answers.csv"); // the file name lives only in the registry (and the 0325 map)
    // the audit row's row-count key is the registry resource key, the same key as the map
    expect(actions).toMatch(/\.map\(\(\{ resource, disposition \}\) => \[resource, manifestCounts\[disposition\.file\]\]\)/);
  });
});

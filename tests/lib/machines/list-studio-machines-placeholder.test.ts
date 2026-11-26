import { describe, expect, it } from "vitest";
import { listStudioMachines, type MachineDb } from "@/lib/machines/machine-queries";

// The studio's machine list feeds the Settings list, studio-devices and every count. The "Machine not specified" placeholder is a row of the same
// table, so the list itself must drop it: a mutant that keeps every row must fail here, with no database involved.

type Row = { id: string; studio_id: string; machine_profile_id: string; machine_profile_version: number; display_name: string; installed_options: string[]; retired_at: string | null; is_unspecified?: boolean };
const row = (id: string, name: string, unspecified?: boolean): Row => ({ id, studio_id: "s1", machine_profile_id: "dectro-apilus:xcell-pur", machine_profile_version: 1, display_name: name, installed_options: [], retired_at: null, ...(unspecified === undefined ? {} : { is_unspecified: unspecified }) });

function dbReturning(rows: Row[], error: unknown = null): MachineDb {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) q[m] = () => q;
  (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(res);
  return { from: () => q } as unknown as MachineDb;
}

describe("listStudioMachines never lists the unspecified placeholder", () => {
  it("drops placeholder rows and keeps every registered unit, in order", async () => {
    const out = await listStudioMachines(dbReturning([row("a", "Alpha"), row("p", "Machine not specified", true), row("b", "Beta", false)]), "s1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((d) => d.deviceId)).toEqual(["a", "b"]);
    expect(out.value.map((d) => d.displayName)).not.toContain("Machine not specified");
  });
  it("a list holding only the placeholder is empty, so a studio with no registered machine counts zero", async () => {
    const out = await listStudioMachines(dbReturning([row("p", "Machine not specified", true)]), "s1");
    expect(out).toEqual({ ok: true, value: [] });
  });
  it("a row without the flag (a database that predates it) is a registered unit", async () => {
    const out = await listStudioMachines(dbReturning([row("a", "Alpha")]), "s1");
    expect(out.ok && out.value).toHaveLength(1);
  });
  it("the query selects the flag, so the filter has something to read", () => {
    const src = require("node:fs").readFileSync("lib/machines/machine-queries.ts", "utf8") as string;
    const fn = src.slice(src.indexOf("export async function listStudioMachines"), src.indexOf("/** Register one physical unit"));
    expect(fn).toContain("is_unspecified");
    expect(fn).toMatch(/\.filter\(\(r\) => r\.is_unspecified !== true\)/);
  });
});

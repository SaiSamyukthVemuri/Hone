import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readIntakeStatusProjection, INTAKE_STATUS_RPC } from "@/lib/intake/status-projection";

type Rec = { fn: string; args: Record<string, unknown>; range: [number, number] };
function fake(pages: (rec: Rec) => { data: unknown; error: { message: string } | null }) {
  const calls: Rec[] = [];
  return {
    calls,
    db: {
      rpc: (fn: string, args: Record<string, unknown>) => ({
        range: async (a: number, z: number) => {
          const rec = { fn, args, range: [a, z] as [number, number] };
          calls.push(rec);
          return pages(rec);
        },
      }),
    },
  };
}
const row = (i: number) => ({ client_id: `c${i}`, status: "submitted", created_at: "2030-01-01T00:00:00Z" });

describe("readIntakeStatusProjection (0334)", () => {
  it("calls the projection by name with the studio and (when given) the client ids; no client list means the whole studio", async () => {
    const f = fake(() => ({ data: [row(1)], error: null }));
    expect(await readIntakeStatusProjection(f.db, "s", ["c1"])).toEqual([row(1)]);
    expect(f.calls[0]).toEqual({ fn: INTAKE_STATUS_RPC, args: { p_studio_id: "s", p_client_ids: ["c1"] }, range: [0, 999] });
    const w = fake(() => ({ data: [], error: null }));
    await readIntakeStatusProjection(w.db, "s");
    expect(w.calls[0].args).toEqual({ p_studio_id: "s", p_client_ids: null });
  });
  it("an empty client list makes no call", async () => {
    const f = fake(() => ({ data: [], error: null }));
    expect(await readIntakeStatusProjection(f.db, "s", [])).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
  it("splits client ids into chunks of 500 and pages each chunk past 1000 rows", async () => {
    const ids = Array.from({ length: 1100 }, (_, i) => `c${i}`);
    const f = fake((rec) => ({ data: rec.range[0] === 0 && (rec.args.p_client_ids as string[]).length === 500 && (rec.args.p_client_ids as string[])[0] === "c0" ? Array.from({ length: 1000 }, (_, i) => row(i)) : [row(9)], error: null }));
    const out = await readIntakeStatusProjection(f.db, "s", ids);
    expect(f.calls.filter((c) => c.range[0] === 0)).toHaveLength(3); // 500 + 500 + 100
    expect(f.calls.some((c) => c.range[0] === 1000)).toBe(true); // the first chunk filled a page, so a second page was asked for
    expect(out!.length).toBe(1000 + 1 + 1 + 1);
  });
  it("a failed page is null (never an empty answer), and so is passing the page ceiling", async () => {
    expect(await readIntakeStatusProjection(fake(() => ({ data: null, error: { message: "x" } })).db, "s")).toBeNull();
    expect(await readIntakeStatusProjection(fake(() => ({ data: Array.from({ length: 1000 }, (_, i) => row(i)), error: null })).db, "s")).toBeNull();
  });
});

describe("every status-only intake reader goes through the projection, not the table (0334)", () => {
  const READERS = [
    "lib/clients/directory-read.ts",
    "lib/dashboard/intakes-awaiting-review.ts",
    "lib/dashboard/missing-records-assistant.ts",
    "app/(app)/dashboard/page.tsx",
  ];
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  it.each(READERS)("%s", (file) => {
    const code = strip(readFileSync(file, "utf8"));
    expect(code).toMatch(/readIntakeStatusProjection\(/);
    expect(code).not.toMatch(/from\(\s*["']client_intake_forms["']\s*\)/);
  });
});

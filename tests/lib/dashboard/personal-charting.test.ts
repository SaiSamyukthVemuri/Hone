import { beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic ids only.
const fx = vi.hoisted(() => ({
  eqs: [] as Array<[string, string, unknown]>,
  fail: null as string | null,
  appts: [] as Array<{ id: string; ends_at: string }>,
  sessions: [] as Array<{ id: string; appointment_id: string }>,
  blocks: [] as Array<{ session_id: string; created_at: string }>,
  cols: [] as Array<[string, string]>,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = (c: string) => ((fx.cols.push([table, c]), q));
      q.eq = (c: string, v: unknown) => ((fx.eqs.push([table, c, v]), q));
      for (const m of ["gte", "lte", "in", "is"]) q[m] = () => q;
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          fx.fail === table
            ? { data: null, error: { message: "x" } }
            : { data: table === "appointments" ? fx.appts : table === "sessions" ? fx.sessions : fx.blocks, error: null },
        );
      return q;
    },
  }),
}));

import { getPersonalChartedWithin24h } from "@/lib/dashboard/personal-charting";

const NOW = "2026-11-01T12:00:00.000Z";
beforeEach(() => {
  fx.eqs = []; fx.cols = []; fx.fail = null;
  fx.appts = [{ id: "a1", ends_at: "2026-10-30T10:00:00Z" }, { id: "a2", ends_at: "2026-10-30T12:00:00Z" }];
  fx.sessions = [{ id: "s1", appointment_id: "a1" }, { id: "s2", appointment_id: "a2" }];
  fx.blocks = [{ session_id: "s1", created_at: "2026-10-30T20:00:00Z" }, { session_id: "s2", created_at: "2026-11-01T09:00:00Z" }];
});

describe("getPersonalChartedWithin24h", () => {
  it("counts only this practitioner's completed appointments, with the studio definition of 'within 24h'", async () => {
    const out = await getPersonalChartedWithin24h("studio-1", "prac-1", NOW);
    expect(out).toEqual({ completedCount: 2, chartedWithin24hCount: 1 });
    expect(fx.eqs).toContainEqual(["appointments", "practitioner_id", "prac-1"]);
    expect(fx.eqs).toContainEqual(["appointments", "status", "completed"]);
  });

  it("reads ids and timestamps only: no client, service or price column", async () => {
    await getPersonalChartedWithin24h("studio-1", "prac-1", NOW);
    for (const [, cols] of fx.cols) expect(cols).not.toMatch(/client|service|price|name|email|phone/);
  });

  it("no completed appointments is a true 0/0, not an error", async () => {
    fx.appts = [];
    expect(await getPersonalChartedWithin24h("studio-1", "prac-1", NOW)).toEqual({ completedCount: 0, chartedWithin24hCount: 0 });
  });

  it.each(["appointments", "sessions", "session_blocks"])("a failed %s read throws, never 0/0", async (table) => {
    fx.fail = table;
    await expect(getPersonalChartedWithin24h("studio-1", "prac-1", NOW)).rejects.toThrow("Failed to load personal charting");
  });
});

import { describe, expect, it } from "vitest";
import {
  DISPLAY_NAME_FALLBACK,
  getClientDisplayNames,
  withDisplayNamesOnDetailGaps,
} from "@/lib/dashboard/client-display-names";
import { buildNeedsAttention } from "@/lib/dashboard/needs-attention-model";
import { buildMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";

// Privacy C1 / Insurance N1. Synthetic names only.
type Row = { id: string; name: string; preferred_name?: string | null };

function fake(rows: Row[], opts: { fail?: boolean; noPreferredColumn?: boolean } = {}) {
  const seen = { chunks: [] as string[][], selects: [] as string[] };
  const client = {
    from: () => {
      let ids: string[] = [];
      let cols = "";
      const q: Record<string, unknown> = {};
      q.select = (c: string) => ((cols = c), (seen.selects.push(c), q));
      q.eq = () => q;
      q.in = (_c: string, v: string[]) => ((ids = v), seen.chunks.push(v), q);
      q.then = (resolve: (v: unknown) => unknown) => {
        if (opts.fail) return resolve({ data: null, error: { message: "x" } });
        if (opts.noPreferredColumn && cols.includes("preferred_name"))
          return resolve({ data: null, error: { code: "42703", message: 'column "preferred_name" does not exist' } });
        return resolve({
          data: rows.filter((r) => ids.includes(r.id)).map((r) => (opts.noPreferredColumn ? { id: r.id, name: r.name } : r)),
          error: null,
        });
      };
      return q;
    },
  };
  return { client: client as never, seen };
}

describe("getClientDisplayNames", () => {
  it("returns the preferred name when set, else the stored name", async () => {
    const { client } = fake([
      { id: "a", name: "Stored Alpha", preferred_name: "Preferred Alpha" },
      { id: "b", name: "Stored Beta", preferred_name: "  " },
      { id: "c", name: "Stored Gamma" },
    ]);
    const m = await getClientDisplayNames(client, "s", ["a", "b", "c"]);
    expect(m.get("a")).toBe("Preferred Alpha");
    expect(m.get("b")).toBe("Stored Beta");
    expect(m.get("c")).toBe("Stored Gamma");
  });

  it("chunks by 100 ids", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, name: `N${i}` }));
    const { client, seen } = fake(rows);
    const m = await getClientDisplayNames(client, "s", rows.map((r) => r.id));
    expect(m.size).toBe(250);
    expect(Math.max(...seen.chunks.map((c) => c.length))).toBeLessThanOrEqual(100);
  });

  it("works on a database without the preferred_name column (falls back to stored)", async () => {
    const { client } = fake([{ id: "a", name: "Stored Alpha", preferred_name: "Preferred Alpha" }], { noPreferredColumn: true });
    expect((await getClientDisplayNames(client, "s", ["a"])).get("a")).toBe("Stored Alpha");
  });
});

describe("withDisplayNamesOnDetailGaps (C1)", () => {
  const gaps = [{ sessionId: "s1", clientId: "a", clientName: "Stored Alpha", startedAt: "2026-10-10T10:00:00Z" }];

  it("replaces the stored name with the preferred name and never shows the stored one", async () => {
    const { client } = fake([{ id: "a", name: "Stored Alpha", preferred_name: "Preferred Alpha" }]);
    const out = await withDisplayNamesOnDetailGaps(client, "s", { detailGaps: gaps });
    expect(out.detailGaps![0].clientName).toBe("Preferred Alpha");
    expect(JSON.stringify(out)).not.toContain("Stored Alpha");
  });

  it("does not mutate the record's own data", async () => {
    const { client } = fake([{ id: "a", name: "Stored Alpha", preferred_name: "Preferred Alpha" }]);
    await withDisplayNamesOnDetailGaps(client, "s", { detailGaps: gaps });
    expect(gaps[0].clientName).toBe("Stored Alpha");
  });

  it("an unreadable name falls back to the neutral label, never the stored name", async () => {
    const { client } = fake([], { fail: true });
    const out = await withDisplayNamesOnDetailGaps(client, "s", { detailGaps: gaps });
    expect(out.detailGaps![0].clientName).toBe(DISPLAY_NAME_FALLBACK);
    expect(JSON.stringify(out)).not.toContain("Stored Alpha");
  });

  it("the same client carries ONE name across an intake entry and a details entry", async () => {
    const { client } = fake([{ id: "a", name: "Stored Alpha", preferred_name: "Preferred Alpha" }]);
    const { detailGaps } = await withDisplayNamesOnDetailGaps(client, "s", { detailGaps: gaps });
    const out = buildNeedsAttention({
      assistant: buildMissingRecordsAssistant({ unchartedAppointments: [], sessions: [], incompleteIntakes: [] }),
      intakesAwaitingReview: [{ clientId: "a", clientName: "Preferred Alpha", submittedAt: "2026-10-09T10:00:00Z" }],
      todo: { items: [], hasItems: false, moreCount: 0 },
      recordDetailGaps: detailGaps,
    });
    expect(new Set(out.entries.map((e) => e.clientName))).toEqual(new Set(["Preferred Alpha"]));
  });
});

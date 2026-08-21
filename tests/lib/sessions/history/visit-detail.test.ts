import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const STUDIO = "11111111-1111-1111-1111-111111111111";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import {
  DETAIL_MAX_AREA_ROWS,
  DETAIL_MAX_BLOCK_ROWS,
  DETAIL_MAX_ENTRY_ROWS,
  DETAIL_MAX_LASER_ROWS,
  loadHistoricalVisitDetail,
  loadHistoricalVisitDetails,
} from "@/lib/sessions/history/visit-detail";

afterEach(() => vi.clearAllMocks());

type Row = Record<string, unknown>;
type Issued = { table: string; verbs: string[] };

/** Chainable PostgREST fake, routed per table so the four reads stay distinct. */
function fakeSupabase(
  byTable: Record<string, Row[]>,
  issued: Issued[],
  errorTable: string | null = null,
) {
  return {
    from(table: string) {
      const rec: Issued = { table, verbs: [] };
      issued.push(rec);
      const b: Record<string, unknown> = {};
      for (const verb of ["select", "eq", "in", "is", "order", "limit"]) {
        b[verb] = (...args: unknown[]) => {
          rec.verbs.push(`${verb}:${String(args[0] ?? "")}`);
          return b;
        };
      }
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        resolve(
          errorTable === table
            ? { data: null, error: { code: "57014", message: "timeout on primary_area" } }
            : { data: byTable[table] ?? [], error: null },
        );
      return b;
    },
  };
}

async function run(
  byTable: Record<string, Row[]>,
  sessionIds: string[],
  expected?: Map<string, number | null>,
  errorTable: string | null = null,
) {
  const issued: Issued[] = [];
  vi.mocked(createClient).mockResolvedValue(
    fakeSupabase(byTable, issued, errorTable) as unknown as Awaited<
      ReturnType<typeof createClient>
    >,
  );
  const out = await loadHistoricalVisitDetails({
    studioId: STUDIO,
    sessionIds,
    expectedLiveBlocks: expected,
  });
  return { out, issued };
}

const block = (id: string, session_id: string, over: Row = {}) => ({
  id,
  session_id,
  primary_area: "Cheek",
  ...over,
});
const entry = (id: string, session_id: string, block_id: string | null, over: Row = {}) => ({
  id,
  session_id,
  block_id,
  hairs_treated: 65,
  ...over,
});
const laser = (id: string, session_id: string, over: Row = {}) => ({
  id,
  session_id,
  zone: "Upper lip",
  observation_notes: "Zone cleared well.",
  ...over,
});

// ---------------------------------------------------------------------------

describe("ONE projection, and it has no column list to drift", () => {
  it("every read is select(*) — the source-level guarantee", () => {
    // THE P1-B REGRESSION GUARD. The retired design embedded
    // `electrolysis_entries(observation_chips, deleted_at)` — two of seventeen
    // columns — and `hairs_treated` silently vanished from every surface. A
    // projection with no column list cannot lose a column.
    const src = readFileSync(
      path.join(path.resolve(__dirname, "../../../.."), "lib/sessions/history/visit-detail.ts"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const selects = code.match(/\.select\(([^)]*)\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s, `non-canonical projection: ${s}`).toBe('.select("*")');
    // ...and no clinical column is named anywhere in the module.
    for (const clinical of [
      "hairs_treated", "primary_area", "caution_note", "energy_level",
      "probe_lot_number", "tolerance_rating", "machine_frequency", "observation_chips",
    ]) {
      expect(code, `${clinical} named in the projection`).not.toContain(`"${clinical}`);
    }
  });

  it("declares a bound on every read, all under PostgREST max_rows", () => {
    const config = readFileSync(
      path.join(path.resolve(__dirname, "../../../.."), "supabase/config.toml"),
      "utf8",
    );
    const cap = Number(config.match(/^max_rows\s*=\s*(\d+)/m)![1]);
    for (const [name, value] of [
      ["DETAIL_MAX_BLOCK_ROWS", DETAIL_MAX_BLOCK_ROWS],
      ["DETAIL_MAX_ENTRY_ROWS", DETAIL_MAX_ENTRY_ROWS],
      ["DETAIL_MAX_LASER_ROWS", DETAIL_MAX_LASER_ROWS],
      ["DETAIL_MAX_AREA_ROWS", DETAIL_MAX_AREA_ROWS],
    ] as const) {
      expect(value, name).toBeLessThanOrEqual(cap);
    }
  });

  it("asks for NOTHING when no visit was selected", async () => {
    const { out, issued } = await run({}, []);
    expect(issued).toHaveLength(0);
    expect(out.size).toBe(0);
  });
});

describe("every channel a visit can record treatment through survives", () => {
  it("carries blocks, their passes, ORPHAN passes and LASER passes", async () => {
    // The three failures the retired design shipped, in one assertion.
    const { out } = await run(
      {
        session_blocks: [block("b1", "s1")],
        electrolysis_entries: [entry("e1", "s1", "b1"), entry("e2", "s1", null)],
        laser_entries: [laser("l1", "s1")],
        session_block_areas: [
          { session_block_id: "b1", area: "Cheek", laterality: "left" },
          { session_block_id: "b1", area: "Sideburn", laterality: "right" },
        ],
      },
      ["s1"],
      new Map([["s1", 1]]),
    );
    const r = out.get("s1")!;
    expect(r.kind).toBe("complete");
    const d = (r as { detail: NonNullable<unknown> }).detail as {
      blocks: Array<{ entries: unknown[]; structured_areas: unknown[] }>;
      orphanEntries: unknown[];
      laserEntries: Array<{ observation_notes: string }>;
    };
    // hairs_treated reaches the block's own pass — the "65 hairs" failure.
    expect(d.blocks[0]!.entries).toHaveLength(1);
    expect((d.blocks[0]!.entries[0] as { hairs_treated: number }).hairs_treated).toBe(65);
    // Multi-area blocks keep EVERY treated area.
    expect(d.blocks[0]!.structured_areas).toEqual([
      { area: "Cheek", laterality: "left" },
      { area: "Sideburn", laterality: "right" },
    ]);
    // A pre-0019 pass with no block is genuinely charted treatment.
    expect(d.orphanEntries).toHaveLength(1);
    // A laser visit's only narrative.
    expect(d.laserEntries[0]!.observation_notes).toBe("Zone cleared well.");
  });

  it("a block's passes are NOT also counted as orphans", async () => {
    const { out } = await run(
      {
        session_blocks: [block("b1", "s1")],
        electrolysis_entries: [entry("e1", "s1", "b1")],
      },
      ["s1"],
      new Map([["s1", 1]]),
    );
    const d = (out.get("s1") as { detail: { orphanEntries: unknown[] } }).detail;
    expect(d.orphanEntries).toHaveLength(0);
  });

  it("a LEGACY entry-only visit carries its passes with no blocks at all", async () => {
    // The visit that rendered "This previous visit has no charted treatment
    // areas" — a false absence about a visit that recorded six passes.
    const { out } = await run(
      { electrolysis_entries: [entry("e1", "s1", null), entry("e2", "s1", null)] },
      ["s1"],
      new Map([["s1", 0]]),
    );
    const r = out.get("s1")!;
    expect(r.kind).toBe("complete");
    const d = (r as { detail: { blocks: unknown[]; orphanEntries: unknown[] } }).detail;
    expect(d.blocks).toHaveLength(0);
    expect(d.orphanEntries).toHaveLength(2);
  });

  it("one visit's rows never leak into another's", async () => {
    const { out } = await run(
      {
        session_blocks: [block("b1", "s1"), block("b2", "s2")],
        electrolysis_entries: [entry("e1", "s2", "b2")],
        laser_entries: [laser("l1", "s1")],
      },
      ["s1", "s2"],
      new Map([["s1", 1], ["s2", 1]]),
    );
    const s1 = (out.get("s1") as { detail: { blocks: Array<{ id: string }>; laserEntries: unknown[] } }).detail;
    const s2 = (out.get("s2") as { detail: { blocks: Array<{ id: string }>; laserEntries: unknown[] } }).detail;
    expect(s1.blocks.map((b) => b.id)).toEqual(["b1"]);
    expect(s2.blocks.map((b) => b.id)).toEqual(["b2"]);
    expect(s1.laserEntries).toHaveLength(1);
    expect(s2.laserEntries).toHaveLength(0);
  });
});

describe("completeness is a COMPARISON, never a default", () => {
  it("as many blocks as the row counted is COMPLETE", async () => {
    const { out } = await run(
      { session_blocks: [block("b1", "s1"), block("b2", "s1")] },
      ["s1"],
      new Map([["s1", 2]]),
    );
    expect(out.get("s1")!.kind).toBe("complete");
  });

  it("FEWER than counted is PARTIAL, and says how many were expected", async () => {
    const { out } = await run({ session_blocks: [block("b1", "s1")] }, ["s1"], new Map([["s1", 4]]));
    expect(out.get("s1")).toMatchObject({ kind: "partial", expectedBlocks: 4 });
  });

  it("a visit that returned NOTHING but WAS counted is PARTIAL, not empty", async () => {
    // `map.get(id) ?? []` rendered exactly this as "recorded no treatment".
    const { out } = await run({}, ["s1"], new Map([["s1", 4]]));
    expect(out.get("s1")).toMatchObject({ kind: "partial", expectedBlocks: 4 });
  });

  it("a genuinely empty visit is complete at zero", async () => {
    const { out } = await run({}, ["s1"], new Map([["s1", 0]]));
    expect(out.get("s1")!.kind).toBe("complete");
  });

  it("an UNKNOWN expectation can never certify completeness", async () => {
    for (const expected of [new Map<string, number | null>([["s1", null]]), undefined]) {
      const { out } = await run({ session_blocks: [block("b1", "s1")] }, ["s1"], expected);
      expect(out.get("s1")!.kind).toBe("partial");
    }
  });

  it("every requested visit gets an entry — none is silently absent", async () => {
    const { out } = await run({}, ["s1", "s2", "s3"], new Map([["s1", 0], ["s2", 0], ["s3", 0]]));
    expect([...out.keys()].sort()).toEqual(["s1", "s2", "s3"]);
  });
});

describe("a read error is a FAILURE for every visit, never an absence", () => {
  for (const table of ["session_blocks", "electrolysis_entries", "laser_entries"]) {
    it(`a failed ${table} read fails ALL of them`, async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { out } = await run({}, ["s1", "s2"], new Map([["s1", 0], ["s2", 0]]), table);
      expect(out.get("s1")).toEqual({ kind: "failed" });
      // Even the visit whose expectation was ZERO: its emptiness was never
      // observed, because the read did not happen.
      expect(out.get("s2")).toEqual({ kind: "failed" });
      spy.mockRestore();
    });
  }

  it("the failure log classifies WITHOUT echoing the statement", async () => {
    // After `select("*")` a raw message names every clinical column.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await run({}, ["s1"], new Map([["s1", 0]]), "session_blocks");
    const payload = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(payload.event).toBe("historical_visit_detail_read_failed");
    expect(payload.code).toBe("57014");
    expect(payload.session_count).toBe(1);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("primary_area");
    expect(text).not.toContain("timeout on");
    expect(text).not.toContain("s1");
    spy.mockRestore();
  });
});

describe("studio authority is re-derived, not trusted", () => {
  it("both studio-scoped tables are filtered on studio_id", async () => {
    const { issued } = await run(
      { session_blocks: [block("b1", "s1")] },
      ["s1"],
      new Map([["s1", 1]]),
    );
    const scoped = issued.filter((q) =>
      ["session_blocks", "session_block_areas"].includes(q.table),
    );
    expect(scoped.length).toBe(2);
    for (const q of scoped) expect(q.verbs, q.table).toContain("eq:studio_id");
  });

  it("blocks are ordered within a session and terminated by the primary key", async () => {
    const { issued } = await run({ session_blocks: [] }, ["s1"], new Map([["s1", 0]]));
    const blocks = issued.find((q) => q.table === "session_blocks")!;
    expect(blocks.verbs.filter((v) => v.startsWith("order:"))).toEqual([
      "order:session_id",
      "order:sort_order",
      "order:id",
    ]);
    expect(blocks.verbs).toContain(`limit:${DETAIL_MAX_BLOCK_ROWS}`);
    expect(blocks.verbs).toContain("is:deleted_at");
  });
});

describe("the on-demand single-visit read is the SAME implementation", () => {
  it("returns the same result shape for one session", async () => {
    const issued: Issued[] = [];
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(
        { session_blocks: [block("b1", "s1")], laser_entries: [laser("l1", "s1")] },
        issued,
      ) as unknown as Awaited<ReturnType<typeof createClient>>,
    );
    const r = await loadHistoricalVisitDetail({
      studioId: STUDIO,
      sessionId: "s1",
      expectedLiveBlocks: 1,
    });
    expect(r.kind).toBe("complete");
    expect((r as { detail: { laserEntries: unknown[] } }).detail.laserEntries).toHaveLength(1);
  });

  it("an unknown expectation on the on-demand path is still partial", async () => {
    const issued: Issued[] = [];
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ session_blocks: [block("b1", "s1")] }, issued) as unknown as Awaited<
        ReturnType<typeof createClient>
      >,
    );
    const r = await loadHistoricalVisitDetail({ studioId: STUDIO, sessionId: "s1" });
    expect(r.kind).toBe("partial");
  });
});

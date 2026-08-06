import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { mergeMemoryBlockRows } from "@/lib/search/treatment-memory-merge";
import { blockAreasLabel } from "@/lib/sessions/block-areas";

// Global Search child-area recall, against the REAL migrated local database
// with RLS enforced.
//
// The action reaches a treatment down two paths. This suite replays BOTH as the
// authenticated practitioner — the same filters, the same order, the same caps —
// so "Studio B is absent" means RLS and the studio filter genuinely excluded it,
// not that a mock was configured to.
//
// The shape under test (mirrors app/(app)/global-search-actions.ts):
//   1. session_block_areas ILIKE area, studio-scoped, bounded  -> child ids
//   2. session_blocks by id, studio-scoped, deleted_at is null -> parents
//   3. merge + dedupe + cap  (the same pure helper the action uses)
//
// session_block_areas has NO soft-delete column of its own (migration 0128; it
// cascades with the parent), so step 2's `deleted_at is null` is the ONLY thing
// keeping a deleted treatment out of search. That is pinned below.

const MEMORY_CAP = 4;
const CHILD_CANDIDATE_CAP = MEMORY_CAP * 5;

const BLOCK_SELECT = `
  select b.id, b.session_id, b.primary_area, b.side, b.created_at
    from public.session_blocks b
   where b.studio_id = $1
     and b.deleted_at is null
     and b.id = any($2::uuid[])
   order by b.created_at desc
   limit ${MEMORY_CAP}`;

const CHILD_MATCH = `
  select a.session_block_id
    from public.session_block_areas a
   where a.studio_id = $1
     and a.area ilike $2
   order by a.created_at desc
   limit ${CHILD_CANDIDATE_CAP}`;

const DIRECT_MATCH = `
  select b.id, b.session_id, b.primary_area, b.side, b.created_at
    from public.session_blocks b
   where b.studio_id = $1
     and b.deleted_at is null
     and (b.primary_area ilike $2 or b.block_name ilike $2)
   order by b.created_at desc
   limit ${MEMORY_CAP}`;

type BlockRow = {
  id: string;
  session_id: string;
  primary_area: string | null;
  side: string | null;
  created_at: string;
};

let a: SeededStudio;
let b: SeededStudio;

// Studio A, the block at the heart of the defect: legacy primary_area "Cheek",
// structured areas "Cheek" (left) + "Sideburn" (right).
let multiAreaBlockId: string;
let multiAreaSessionId: string;
// Studio A, matched by BOTH the parent text and a child area.
let bothPathsBlockId: string;
// Studio A, soft-deleted, but its child area still says "Sideburn".
let deletedBlockId: string;
// Studio B, a genuine "Sideburn" treatment that must never leak.
let foreignBlockId: string;

async function seedBlock(
  studio: SeededStudio,
  opts: {
    primaryArea: string | null;
    areas: Array<{ area: string; laterality: string }>;
    createdAt: string;
    deleted?: boolean;
  },
): Promise<{ blockId: string; sessionId: string }> {
  const sessionId = randomUUID();
  const blockId = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
     values ($1, $2, $3, $4, 'electrolysis')`,
    [sessionId, studio.studioId, studio.clientId, studio.practitionerId],
  );
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, primary_area, created_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      blockId,
      studio.studioId,
      sessionId,
      opts.primaryArea,
      opts.createdAt,
      opts.deleted ? new Date().toISOString() : null,
    ],
  );
  let order = 0;
  for (const area of opts.areas) {
    await adminQuery(
      `insert into public.session_block_areas
         (id, session_block_id, studio_id, area, laterality, display_order)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), blockId, studio.studioId, area.area, area.laterality, order++],
    );
  }
  return { blockId, sessionId };
}

beforeAll(async () => {
  a = await seedStudio("gs-child-a");
  b = await seedStudio("gs-child-b");

  const multi = await seedBlock(a, {
    primaryArea: "Cheek",
    areas: [
      { area: "Cheek", laterality: "left" },
      { area: "Sideburn", laterality: "right" },
    ],
    createdAt: "2026-05-01T00:00:00Z",
  });
  multiAreaBlockId = multi.blockId;
  multiAreaSessionId = multi.sessionId;

  bothPathsBlockId = (
    await seedBlock(a, {
      primaryArea: "Sideburn",
      areas: [{ area: "Sideburn", laterality: "left" }],
      createdAt: "2026-04-01T00:00:00Z",
    })
  ).blockId;

  deletedBlockId = (
    await seedBlock(a, {
      primaryArea: "Jaw",
      areas: [{ area: "Sideburn", laterality: "left" }],
      createdAt: "2026-03-01T00:00:00Z",
      deleted: true,
    })
  ).blockId;

  foreignBlockId = (
    await seedBlock(b, {
      primaryArea: "Sideburn",
      areas: [{ area: "Sideburn", laterality: "right" }],
      createdAt: "2026-06-01T00:00:00Z",
    })
  ).blockId;
});

afterAll(async () => {
  await closePool();
});

// Replay the action's two-query strategy as the given practitioner.
async function searchMemory(
  studio: SeededStudio,
  query: string,
): Promise<BlockRow[]> {
  const like = `%${query}%`;
  return asUser(studio.userId, async (q) => {
    const direct = await q(DIRECT_MATCH, [studio.studioId, like]);
    const child = await q(CHILD_MATCH, [studio.studioId, like]);
    const childIds = [
      ...new Set((child.rows as Array<{ session_block_id: string }>).map((r) => r.session_block_id)),
    ];
    const parents =
      childIds.length > 0
        ? await q(BLOCK_SELECT, [studio.studioId, childIds])
        : { rows: [] as BlockRow[] };
    return mergeMemoryBlockRows(
      direct.rows as BlockRow[],
      parents.rows as BlockRow[],
      MEMORY_CAP,
    );
  });
}

async function areaLabel(studio: SeededStudio, blockId: string): Promise<string | null> {
  return asUser(studio.userId, async (q) => {
    const rows = await q(
      `select area, laterality from public.session_block_areas
        where studio_id = $1 and session_block_id = $2
        order by display_order asc, created_at asc`,
      [studio.studioId, blockId],
    );
    const block = await q(
      `select primary_area, side from public.session_blocks where id = $1`,
      [blockId],
    );
    return blockAreasLabel(
      rows.rows as Array<{ area: string; laterality: never }>,
      (block.rows[0] ?? {}) as { primary_area?: string | null; side?: string | null },
    );
  });
}

describe("positive controls — the queries themselves work", () => {
  it("practitioner A can read her own structured areas at all", async () => {
    await asUser(a.userId, async (q) => {
      const rows = await q(
        `select area from public.session_block_areas
          where studio_id = $1 and session_block_id = $2 order by display_order`,
        [a.studioId, multiAreaBlockId],
      );
      expect(rows.rows.map((r) => (r as { area: string }).area)).toEqual([
        "Cheek",
        "Sideburn",
      ]);
    });
  });

  it("the block's LEGACY primary_area really is Cheek, not Sideburn", async () => {
    // Without this the whole suite could pass vacuously against a block whose
    // parent column happened to contain the word already.
    await asUser(a.userId, async (q) => {
      const rows = await q(
        `select primary_area from public.session_blocks where id = $1`,
        [multiAreaBlockId],
      );
      expect((rows.rows[0] as { primary_area: string }).primary_area).toBe("Cheek");
    });
  });

  it("the DIRECT path alone does NOT find it — this is the defect", async () => {
    await asUser(a.userId, async (q) => {
      const direct = await q(DIRECT_MATCH, [a.studioId, "%Sideburn%"]);
      const ids = (direct.rows as BlockRow[]).map((r) => r.id);
      expect(ids).not.toContain(multiAreaBlockId);
    });
  });
});

describe("searching a SECONDARY structured area finds the treatment", () => {
  it("finds the active Studio A multi-area block", async () => {
    const rows = await searchMemory(a, "Sideburn");
    expect(rows.map((r) => r.id)).toContain(multiAreaBlockId);
  });

  it("the full label carries BOTH Cheek and Sideburn", async () => {
    const label = await areaLabel(a, multiAreaBlockId);
    expect(label).toBe("Left Cheek · Right Sideburn");
    expect(label).toContain("Cheek");
    expect(label).toContain("Sideburn");
  });

  it("the result points at the correct client session", async () => {
    const rows = await searchMemory(a, "Sideburn");
    const hit = rows.find((r) => r.id === multiAreaBlockId);
    expect(hit?.session_id).toBe(multiAreaSessionId);
  });

  it("is case-insensitive", async () => {
    for (const q of ["sideburn", "SIDEBURN", "SideBurn"]) {
      const rows = await searchMemory(a, q);
      expect(rows.map((r) => r.id)).toContain(multiAreaBlockId);
    }
  });
});

describe("tenant isolation and parent integrity hold under real RLS", () => {
  it("Studio B's Sideburn treatment is absent from Studio A's results", async () => {
    const rows = await searchMemory(a, "Sideburn");
    expect(rows.map((r) => r.id)).not.toContain(foreignBlockId);
  });

  it("...and Studio B genuinely HAS one (so absence is filtering, not emptiness)", async () => {
    const rows = await searchMemory(b, "Sideburn");
    expect(rows.map((r) => r.id)).toContain(foreignBlockId);
    expect(rows.map((r) => r.id)).not.toContain(multiAreaBlockId);
  });

  it("a foreign child area row is not even readable by practitioner A", async () => {
    await asUser(a.userId, async (q) => {
      const rows = await q(
        `select id from public.session_block_areas where session_block_id = $1`,
        [foreignBlockId],
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  it("a soft-deleted parent never surfaces, though its child area still matches", async () => {
    // Prove the child row survived the soft delete first — otherwise the
    // exclusion below would be proving nothing.
    await asUser(a.userId, async (q) => {
      const child = await q(
        `select id from public.session_block_areas
          where studio_id = $1 and session_block_id = $2 and area ilike '%Sideburn%'`,
        [a.studioId, deletedBlockId],
      );
      expect(child.rowCount).toBe(1);
    });
    const rows = await searchMemory(a, "Sideburn");
    expect(rows.map((r) => r.id)).not.toContain(deletedBlockId);
  });
});

describe("deduplication and caps", () => {
  it("a block matched by BOTH the parent column and a child area is ONE result", async () => {
    const rows = await searchMemory(a, "Sideburn");
    const hits = rows.filter((r) => r.id === bothPathsBlockId);
    expect(hits).toHaveLength(1);
    // ...and it really did match both paths.
    await asUser(a.userId, async (q) => {
      const direct = await q(DIRECT_MATCH, [a.studioId, "%Sideburn%"]);
      expect((direct.rows as BlockRow[]).map((r) => r.id)).toContain(bothPathsBlockId);
      const child = await q(CHILD_MATCH, [a.studioId, "%Sideburn%"]);
      expect(
        (child.rows as Array<{ session_block_id: string }>).map((r) => r.session_block_id),
      ).toContain(bothPathsBlockId);
    });
  });

  it("every returned block id is unique", async () => {
    const rows = await searchMemory(a, "Sideburn");
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("respects MEMORY_CAP even when many blocks match through child areas", async () => {
    const extra = await seedStudio("gs-child-cap");
    for (let i = 0; i < 9; i++) {
      await seedBlock(extra, {
        primaryArea: "Jaw",
        areas: [{ area: "Sideburn", laterality: "left" }],
        createdAt: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    const rows = await searchMemory(extra, "Sideburn");
    expect(rows.length).toBe(MEMORY_CAP);
    expect(new Set(rows.map((r) => r.id)).size).toBe(MEMORY_CAP);
    // Newest first.
    const dates = rows.map((r) => new Date(r.created_at).getTime());
    expect([...dates].sort((x, y) => y - x)).toEqual(dates);
  });
});

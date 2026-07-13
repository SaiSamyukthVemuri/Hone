import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Behavioural proof of migration 0128 (session_block_areas): multiple treated
// areas + per-area laterality under one settings block, against the REAL
// migrated local DB. Studio-derive anti-spoof, RLS isolation, duplicate
// prevention, cascade, and CHECK constraints.

let a: SeededStudio;
let b: SeededStudio;
let aBlockId: string;
let bBlockId: string;

const INS = `insert into public.session_block_areas
  (session_block_id, studio_id, area, laterality, display_order)
  values ($1, $2, $3, $4, coalesce($5, 0)) returning id, studio_id`;

beforeAll(async () => {
  a = await seedStudio("sba-a");
  b = await seedStudio("sba-b");
  aBlockId = (await seedSession(a)).blockId;
  bBlockId = (await seedSession(b)).blockId;
});
afterAll(async () => {
  await closePool();
});

describe("create + read (member, same studio)", () => {
  it("records multiple areas with different laterality under one block", async () => {
    await asUser(a.userId, async (q) => {
      const r1 = await q(INS, [aBlockId, a.studioId, "Cheek", "left", 0]);
      const r2 = await q(INS, [aBlockId, a.studioId, "Sideburn", "right", 1]);
      expect(r1.rows[0].studio_id).toBe(a.studioId);
      expect(r2.rows[0].studio_id).toBe(a.studioId);
      const all = await q(
        `select area, laterality from public.session_block_areas
         where session_block_id = $1 order by display_order`,
        [aBlockId],
      );
      expect(all.rows).toEqual([
        { area: "Cheek", laterality: "left" },
        { area: "Sideburn", laterality: "right" },
      ]);
    });
  });

  it("allows the same area with a DIFFERENT laterality (left + right cheek)", async () => {
    const { blockId } = await seedSession(a);
    await asUser(a.userId, async (q) => {
      await q(INS, [blockId, a.studioId, "Cheek", "left", 0]);
      await q(INS, [blockId, a.studioId, "Cheek", "right", 1]);
      const n = await q(
        `select count(*)::int as n from public.session_block_areas where session_block_id = $1`,
        [blockId],
      );
      expect(n.rows[0].n).toBe(2);
    });
  });
});

describe("constraints", () => {
  it("rejects a duplicate (area, laterality) pair in one block", async () => {
    const { blockId } = await seedSession(a);
    await asUser(a.userId, (q) => q(INS, [blockId, a.studioId, "Chin", "bilateral", 0]));
    await expect(
      asUser(a.userId, (q) => q(INS, [blockId, a.studioId, "Chin", "bilateral", 1])),
    ).rejects.toMatchObject({ code: "23505" });
  });
  it("rejects an invalid laterality value", async () => {
    await expect(
      asUser(a.userId, (q) => q(INS, [aBlockId, a.studioId, "Neck", "sideways", 0])),
    ).rejects.toThrow();
  });
  it("rejects a blank area", async () => {
    await expect(
      asUser(a.userId, (q) => q(INS, [aBlockId, a.studioId, "   ", "left", 0])),
    ).rejects.toThrow();
  });
});

describe("tenant isolation + studio-derive", () => {
  it("studio B cannot READ studio A's block areas", async () => {
    await asUser(b.userId, async (q) => {
      const r = await q(
        `select id from public.session_block_areas where session_block_id = $1`,
        [aBlockId],
      );
      expect(r.rowCount).toBe(0);
    });
  });
  it("studio B cannot INSERT an area onto studio A's block", async () => {
    await expect(
      asUser(b.userId, (q) => q(INS, [aBlockId, b.studioId, "Cheek", "left", 0])),
    ).rejects.toThrow();
  });
  it("the studio-derive trigger overrides a spoofed studio_id (admin path)", async () => {
    const r = await adminQuery(INS, [aBlockId, b.studioId /* spoofed */, "Lip", "midline", 0]);
    expect(r.rows[0].studio_id).toBe(a.studioId);
  });
  it("a non-existent block is rejected", async () => {
    await expect(
      asUser(a.userId, (q) => q(INS, [randomUUID(), a.studioId, "Cheek", "left", 0])),
    ).rejects.toThrow();
  });
});

describe("editable + cascade", () => {
  it("a member can update + delete an area (editable, not append-only)", async () => {
    const { blockId } = await seedSession(a);
    const id = await asUser(a.userId, async (q) => {
      const r = await q(INS, [blockId, a.studioId, "Cheek", "left", 0]);
      return r.rows[0].id as string;
    });
    await asUser(a.userId, (q) =>
      q(`update public.session_block_areas set laterality = 'right' where id = $1`, [id]),
    );
    await asUser(a.userId, (q) =>
      q(`delete from public.session_block_areas where id = $1`, [id]),
    );
    const g = await adminQuery(`select count(*)::int as n from public.session_block_areas where id = $1`, [id]);
    expect(g.rows[0].n).toBe(0);
  });
  it("deleting the parent block cascades to its areas", async () => {
    const { blockId } = await seedSession(a);
    await asUser(a.userId, (q) => q(INS, [blockId, a.studioId, "Chin", "bilateral", 0]));
    await adminQuery(`delete from public.session_blocks where id = $1`, [blockId]);
    const g = await adminQuery(
      `select count(*)::int as n from public.session_block_areas where session_block_id = $1`,
      [blockId],
    );
    expect(g.rows[0].n).toBe(0);
  });
});

// Migration 0129: atomic create/update RPCs. These replace the earlier
// delete-then-insert app write; the whole block + area set commits together.
const AREAS = (arr: Array<{ area: string; laterality: string }>) => JSON.stringify(arr);

describe("0129 — atomic block + area writes (RPCs)", () => {
  it("create_session_block_with_areas creates the block + areas + projection together", async () => {
    const { sessionId } = await seedSession(a);
    const blockId = await asUser(a.userId, async (q) => {
      const r = await q(
        `select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb) as id`,
        [a.studioId, sessionId, JSON.stringify({ primary_area: "Cheeks", side: "left" }),
          AREAS([{ area: "Cheeks", laterality: "left" }, { area: "Sideburns", laterality: "right" }])],
      );
      return r.rows[0].id as string;
    });
    const areas = await adminQuery(
      `select area, laterality from public.session_block_areas where session_block_id=$1 order by display_order`,
      [blockId],
    );
    expect(areas.rows).toEqual([
      { area: "Cheeks", laterality: "left" },
      { area: "Sideburns", laterality: "right" },
    ]);
    const b0 = await adminQuery(`select primary_area, side from public.session_blocks where id=$1`, [blockId]);
    expect(b0.rows[0]).toMatchObject({ primary_area: "Cheeks", side: "left" });
  });

  it("update_session_block_with_areas replaces the whole set", async () => {
    const { sessionId, blockId } = await seedSession(a);
    await asUser(a.userId, (q) =>
      q(`select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb)`,
        [a.studioId, sessionId, blockId, AREAS([{ area: "Chin", laterality: "bilateral" }])]));
    await asUser(a.userId, (q) =>
      q(`select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb)`,
        [a.studioId, sessionId, blockId, AREAS([{ area: "Neck", laterality: "midline" }])]));
    const areas = await adminQuery(
      `select area, laterality from public.session_block_areas where session_block_id=$1`, [blockId]);
    expect(areas.rows).toEqual([{ area: "Neck", laterality: "midline" }]);
  });

  it("ATOMIC: a failed replacement preserves the prior area set (NO data loss)", async () => {
    const { sessionId, blockId } = await seedSession(a);
    await asUser(a.userId, (q) =>
      q(`select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb)`,
        [a.studioId, sessionId, blockId,
          AREAS([{ area: "Chin", laterality: "left" }, { area: "Upper lip", laterality: "right" }])]));
    // A replacement whose new set violates the unique(block, area, laterality)
    // constraint must roll the WHOLE function back — delete included.
    await expect(
      asUser(a.userId, (q) =>
        q(`select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb)`,
          [a.studioId, sessionId, blockId,
            AREAS([{ area: "Neck", laterality: "left" }, { area: "Neck", laterality: "left" }])])),
    ).rejects.toThrow();
    // The committed prior set is intact — nothing was deleted-without-replacement.
    const rows = await adminQuery(
      `select area, laterality from public.session_block_areas where session_block_id=$1 order by display_order`,
      [blockId]);
    expect(rows.rows).toEqual([
      { area: "Chin", laterality: "left" },
      { area: "Upper lip", laterality: "right" },
    ]);
  });

  it("a non-member cannot call the create RPC (is_studio_member gate)", async () => {
    const { sessionId } = await seedSession(a);
    await expect(
      asUser(b.userId, (q) =>
        q(`select public.create_session_block_with_areas($1,$2,'{}'::jsonb,$3::jsonb)`,
          [a.studioId, sessionId, AREAS([{ area: "Chin", laterality: "left" }])])),
    ).rejects.toThrow(/not authorized/i);
  });

  it("a member cannot update a block in ANOTHER studio via the RPC", async () => {
    await expect(
      asUser(b.userId, (q) =>
        q(`select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb)`,
          [a.studioId, aBlockId, aBlockId, AREAS([{ area: "Chin", laterality: "left" }])])),
    ).rejects.toThrow();
  });
});

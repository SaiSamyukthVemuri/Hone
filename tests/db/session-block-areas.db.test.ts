import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
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
//
// UPDATED BY 0159. Structured areas are the AUTHORITATIVE clinical area record,
// so browser roles no longer hold direct DML on the table: `authenticated` keeps
// studio-scoped SELECT only, and every write goes through the trusted
// SECURITY DEFINER commands. The trigger/constraint coverage below therefore
// drives the table through the OWNER connection (adminQuery), which is the only
// way left to exercise a raw INSERT, the member-facing posture (SELECT yes, direct DML no) is proven in
// tests/db/clinical-finalization-retired.db.test.ts.

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

describe("create + read (member reads what the trusted path wrote)", () => {
  it("records multiple areas with different laterality under one block", async () => {
    const r1 = await adminQuery(INS, [aBlockId, a.studioId, "Cheek", "left", 0]);
    const r2 = await adminQuery(INS, [aBlockId, a.studioId, "Sideburn", "right", 1]);
    expect(r1.rows[0].studio_id).toBe(a.studioId);
    expect(r2.rows[0].studio_id).toBe(a.studioId);
    // The member still SELECTs its own studio's rows (0159 keeps read access).
    const all = await asUser(a.userId, (q) =>
      q(
        `select area, laterality from public.session_block_areas
         where session_block_id = $1 order by display_order`,
        [aBlockId],
      ),
    );
    expect(all.rows).toEqual([
      { area: "Cheek", laterality: "left" },
      { area: "Sideburn", laterality: "right" },
    ]);
  });

  it("allows the same area with a DIFFERENT laterality (left + right cheek)", async () => {
    const { blockId } = await seedSession(a);
    await adminQuery(INS, [blockId, a.studioId, "Cheek", "left", 0]);
    await adminQuery(INS, [blockId, a.studioId, "Cheek", "right", 1]);
    const n = await asUser(a.userId, (q) =>
      q(
        `select count(*)::int as n from public.session_block_areas where session_block_id = $1`,
        [blockId],
      ),
    );
    expect(n.rows[0].n).toBe(2);
  });
});

describe("constraints", () => {
  it("rejects a duplicate (area, laterality) pair in one block", async () => {
    const { blockId } = await seedSession(a);
    await adminQuery(INS, [blockId, a.studioId, "Chin", "bilateral", 0]);
    await expect(
      adminQuery(INS, [blockId, a.studioId, "Chin", "bilateral", 1]),
    ).rejects.toMatchObject({ code: "23505" });
  });
  it("rejects an invalid laterality value", async () => {
    await expect(adminQuery(INS, [aBlockId, a.studioId, "Neck", "sideways", 0])).rejects.toThrow();
  });
  it("rejects a blank area", async () => {
    await expect(adminQuery(INS, [aBlockId, a.studioId, "   ", "left", 0])).rejects.toThrow();
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
    // Post-0159 the denial lands at the privilege layer (42501) before RLS is
    // consulted at all, a strictly stronger guarantee than the RLS-only check
    // this test originally asserted.
    await expect(
      asUser(b.userId, (q) => q(INS, [aBlockId, b.studioId, "Cheek", "left", 0])),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("the studio-derive trigger overrides a spoofed studio_id (owner path)", async () => {
    const r = await adminQuery(INS, [aBlockId, b.studioId /* spoofed */, "Lip", "midline", 0]);
    expect(r.rows[0].studio_id).toBe(a.studioId);
  });
  it("…and for service_role, the one NON-OWNER role that still holds DML (0159)", async () => {
    // The derive trigger is SECURITY INVOKER and reads public.session_blocks, so
    // it behaves differently per role. After 0159 revoked browser DML, service_role
    // is the only non-owner role that can still exercise it, keep that covered.
    const r = await asRole("service_role", (q) =>
      q(INS, [aBlockId, b.studioId /* spoofed */, "Jawline", "right", 0]),
    );
    expect(r.rows[0].studio_id).toBe(a.studioId);
  });
  it("a studio_id-only UPDATE is re-derived, not honoured (0159 widened the trigger)", async () => {
    const { blockId } = await seedSession(a);
    const id = (await adminQuery(INS, [blockId, a.studioId, "Temple", "left", 0])).rows[0]
      .id as string;
    await adminQuery("update public.session_block_areas set studio_id=$2 where id=$1", [
      id,
      b.studioId,
    ]);
    const row = await adminQuery("select studio_id from public.session_block_areas where id=$1", [
      id,
    ]);
    expect(row.rows[0].studio_id).toBe(a.studioId);
  });
  it("a non-existent block is rejected", async () => {
    await expect(adminQuery(INS, [randomUUID(), a.studioId, "Cheek", "left", 0])).rejects.toThrow();
  });
});

describe("editable + cascade", () => {
  it("a DRAFT area set stays editable (update + delete) through the trusted path", async () => {
    const { blockId } = await seedSession(a);
    const id = (await adminQuery(INS, [blockId, a.studioId, "Cheek", "left", 0])).rows[0]
      .id as string;
    await adminQuery(`update public.session_block_areas set laterality = 'right' where id = $1`, [id]);
    await adminQuery(`delete from public.session_block_areas where id = $1`, [id]);
    const g = await adminQuery(`select count(*)::int as n from public.session_block_areas where id = $1`, [id]);
    expect(g.rows[0].n).toBe(0);
  });
  it("a member holds NO direct DML on the table (0159)", async () => {
    const { blockId } = await seedSession(a);
    const id = (await adminQuery(INS, [blockId, a.studioId, "Cheek", "left", 0])).rows[0]
      .id as string;
    await expect(
      asUser(a.userId, (q) => q(INS, [blockId, a.studioId, "Chin", "bilateral", 1])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(a.userId, (q) =>
        q(`update public.session_block_areas set laterality = 'right' where id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(a.userId, (q) => q(`delete from public.session_block_areas where id = $1`, [id])),
    ).rejects.toMatchObject({ code: "42501" });
    const g = await adminQuery(
      `select laterality from public.session_block_areas where id = $1`,
      [id],
    );
    expect(g.rows[0].laterality).toBe("left"); // untouched
  });
  it("deleting the parent block cascades to its areas", async () => {
    const { blockId } = await seedSession(a);
    await adminQuery(INS, [blockId, a.studioId, "Chin", "bilateral", 0]);
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

describe("0129: atomic block + area writes (RPCs)", () => {
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
    // constraint must roll the WHOLE function back, delete included.
    await expect(
      asUser(a.userId, (q) =>
        q(`select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb)`,
          [a.studioId, sessionId, blockId,
            AREAS([{ area: "Neck", laterality: "left" }, { area: "Neck", laterality: "left" }])])),
    ).rejects.toThrow();
    // The committed prior set is intact, nothing was deleted-without-replacement.
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

describe("0129: area-set transitions are canonical + atomic (no stale rows)", () => {
  const readAreas = async (blockId: string) =>
    (
      await adminQuery(
        `select area, laterality, display_order from public.session_block_areas
         where session_block_id=$1 order by display_order`,
        [blockId],
      )
    ).rows;
  const upd = (uid: string, sid: string, bid: string, areas: Array<{ area: string; laterality: string }>, expected?: string) =>
    asUser(uid, (q) =>
      q(
        `select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb,$5)`,
        [a.studioId, sid, bid, AREAS(areas), expected ?? null],
      ),
    );
  // Read updated_at as TEXT (full microsecond precision). node-pg would coerce a
  // timestamptz to a millisecond-precision JS Date, which loses sub-ms digits and
  // would falsely trip the exact-equality concurrency check. The app reads it as a
  // full-precision ISO string from PostgREST, so this mirrors the real path.
  const blockUpdatedAt = async (bid: string) =>
    (await adminQuery(`select updated_at::text as updated_at from public.session_blocks where id=$1`, [bid]))
      .rows[0].updated_at as string;

  it("legacy-one → structured-one, then one → many, many → one, many → different many, many → zero", async () => {
    const { sessionId, blockId } = await seedSession(a); // legacy block (primary_area only, no child rows)
    // legacy → structured one
    await upd(a.userId, sessionId, blockId, [{ area: "Chin", laterality: "bilateral" }]);
    expect(await readAreas(blockId)).toEqual([{ area: "Chin", laterality: "bilateral", display_order: 0 }]);
    // one → many
    await upd(a.userId, sessionId, blockId, [{ area: "Cheeks", laterality: "left" }, { area: "Sideburns", laterality: "right" }]);
    expect((await readAreas(blockId)).map((r) => r.area)).toEqual(["Cheeks", "Sideburns"]);
    // many → one (stale Sideburns row must be gone)
    await upd(a.userId, sessionId, blockId, [{ area: "Cheeks", laterality: "left" }]);
    expect(await readAreas(blockId)).toEqual([{ area: "Cheeks", laterality: "left", display_order: 0 }]);
    // many → different many
    await upd(a.userId, sessionId, blockId, [{ area: "Neck", laterality: "midline" }, { area: "Lip", laterality: "not_applicable" }]);
    expect((await readAreas(blockId)).map((r) => `${r.area}:${r.laterality}`)).toEqual(["Neck:midline", "Lip:not_applicable"]);
    // many → zero (all child rows removed, block preserved)
    await upd(a.userId, sessionId, blockId, []);
    expect(await readAreas(blockId)).toEqual([]);
    const b0 = await adminQuery(`select count(*)::int n from public.session_blocks where id=$1 and deleted_at is null`, [blockId]);
    expect(b0.rows[0].n).toBe(1);
  });

  it("reorder-only persists deterministic display_order", async () => {
    const { sessionId, blockId } = await seedSession(a);
    await upd(a.userId, sessionId, blockId, [{ area: "Cheeks", laterality: "left" }, { area: "Chin", laterality: "bilateral" }]);
    await upd(a.userId, sessionId, blockId, [{ area: "Chin", laterality: "bilateral" }, { area: "Cheeks", laterality: "left" }]);
    expect((await readAreas(blockId)).map((r) => r.area)).toEqual(["Chin", "Cheeks"]);
  });

  it("stale-version conflict: an outdated expected_updated_at is rejected; current succeeds", async () => {
    const { sessionId, blockId } = await seedSession(a);
    const v0 = await blockUpdatedAt(blockId);
    await upd(a.userId, sessionId, blockId, [{ area: "Chin", laterality: "left" }], v0); // v0 is current → ok
    // v0 is now stale (the update bumped updated_at).
    await expect(
      upd(a.userId, sessionId, blockId, [{ area: "Neck", laterality: "left" }], v0),
    ).rejects.toThrow(/stale_block_version/);
    // The prior set is intact after the rejected stale edit.
    expect((await readAreas(blockId)).map((r) => r.area)).toEqual(["Chin"]);
    // The current version succeeds.
    const v1 = await blockUpdatedAt(blockId);
    await upd(a.userId, sessionId, blockId, [{ area: "Neck", laterality: "left" }], v1);
    expect((await readAreas(blockId)).map((r) => r.area)).toEqual(["Neck"]);
  });

  it("injection: extra JSON keys cannot re-tenant the block or change session/id", async () => {
    const { sessionId, blockId } = await seedSession(a);
    // Attempt to inject studio_id (studio b), session_id, id into the block bag.
    await asUser(a.userId, (q) =>
      q(
        `select public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb,null)`,
        [a.studioId, sessionId, blockId,
          JSON.stringify({ studio_id: b.studioId, session_id: randomUUID(), id: randomUUID(), mode: "thermo" }),
          AREAS([{ area: "Chin", laterality: "left" }])],
      ),
    );
    const row = await adminQuery(`select studio_id, session_id, id, mode from public.session_blocks where id=$1`, [blockId]);
    expect(row.rows[0].studio_id).toBe(a.studioId); // unchanged, injection ignored
    expect(row.rows[0].session_id).toBe(sessionId);
    expect(row.rows[0].id).toBe(blockId);
    expect(row.rows[0].mode).toBe("thermo"); // the allow-listed field WAS applied
  });
});

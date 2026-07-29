import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  resolveLocalDbUrl,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// Migration 0158 — containment of the P0 "finalized structured treatment areas
// are mutable, unsigned and outside the correction lineage" (audit F-CLIN-000).
//
// Behavioural proof against the REAL migrated local DB. `session_block_areas`
// (0128) is the AUTHORITATIVE area + laterality record, but it shipped outside
// the 0119/0120 clinical-integrity machinery: no finalized-record trigger, full
// table DML for `authenticated`, absent from the signed snapshot, and with no
// correction applier. 0158 contains the MUTATION half of that defect:
//
//   * a finalized-parent guard trigger on every INSERT / UPDATE / DELETE,
//     including block reassignment and reorder, for EVERY role (service_role
//     included) with NO correction-context bypass;
//   * the guard locks public.sessions FOR NO KEY UPDATE — conflicting with the
//     FOR UPDATE finalize_session takes, so an area write and a finalization can
//     never interleave, while staying compatible with the FOR KEY SHARE a child
//     insert needs (which is what keeps it deadlock-free against 0123);
//   * once finalized, ALWAYS frozen: the freeze keys on the finalization evidence,
//     so a record_status round-trip cannot reopen the write window;
//   * direct browser DML is revoked (studio-scoped SELECT is retained);
//   * the two charting RPCs lock + validate the parent encounter first.
//
// It does NOT make finalized areas tamper-EVIDENT — structured areas are still
// absent from the signed snapshot. That is snapshot v2, a mandatory follow-up
// tracked in docs/runbooks/0158-finalized-structured-area-containment.md.
// ===========================================================================

let a: SeededStudio;
let b: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("fsac-a");
  b = await seedStudio("fsac-b");
});
afterAll(async () => {
  await closePool();
});

// --- helpers ---------------------------------------------------------------

const AREAS = (arr: Array<{ area: string; laterality: string }>) => JSON.stringify(arr);

const CREATE_RPC =
  "select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb) as id";
const UPDATE_RPC =
  "select public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb,$6)";

// Seed a draft session that already carries a real structured area set, written
// through the trusted path (never a direct table write).
async function seedCharted(
  studio: SeededStudio,
  areas: Array<{ area: string; laterality: string }> = [
    { area: "Cheek", laterality: "left" },
    { area: "Sideburn", laterality: "right" },
  ],
): Promise<{ sessionId: string; blockId: string; areaIds: string[] }> {
  const { sessionId } = await seedSession(studio);
  const blockId = (
    await userQuery(studio.userId, CREATE_RPC, [
      studio.studioId,
      sessionId,
      JSON.stringify({ primary_area: areas[0]?.area ?? null, mode: "thermo" }),
      AREAS(areas),
    ])
  ).rows[0].id as string;
  const areaIds = (
    await adminQuery(
      "select id from public.session_block_areas where session_block_id=$1 order by display_order",
      [blockId],
    )
  ).rows.map((r) => r.id as string);
  return { sessionId, blockId, areaIds };
}

// Flip a draft to finalized through the REAL RPC (flag + min-charting + actor),
// so the guard is proven against genuinely finalized records — not a hand-set
// status column.
async function finalizeForReal(studio: SeededStudio, sessionId: string): Promise<void> {
  await adminQuery(
    "update public.studios set clinical_finalization_enabled = true where id = $1",
    [studio.studioId],
  );
  const blockId = (
    await adminQuery(
      "select id from public.session_blocks where session_id=$1 and deleted_at is null order by sort_order limit 1",
      [sessionId],
    )
  ).rows[0].id as string;
  await adminQuery(
    "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
    [randomUUID(), sessionId, blockId],
  );
  const r = await userQuery(studio.userId, "select * from public.finalize_session($1,$2)", [
    sessionId,
    1,
  ]);
  expect(r.rows[0].already_finalized).toBe(false);
}

async function setStatus(sessionId: string, status: "void" | "draft"): Promise<void> {
  await adminQuery("update public.sessions set record_status=$2 where id=$1", [
    sessionId,
    status,
  ]);
}

async function areaSnapshot(blockId: string) {
  return (
    await adminQuery(
      `select area, laterality, display_order from public.session_block_areas
        where session_block_id=$1 order by display_order, area`,
      [blockId],
    )
  ).rows;
}

const FINALIZED_MSG = /finalized and read-only/i;

// ===========================================================================
// A. Direct table access — the browser role and the RLS-exempt roles.
// ===========================================================================
describe("A. direct authenticated table access", () => {
  it("a studio member may still SELECT its own structured areas (draft)", async () => {
    const { blockId } = await seedCharted(a);
    const rows = await asUser(a.userId, (q) =>
      q("select area, laterality from public.session_block_areas where session_block_id=$1", [
        blockId,
      ]),
    );
    expect(rows.rowCount).toBe(2);
  });

  it("direct INSERT / UPDATE / DELETE are denied for a DRAFT session (privilege revoked)", async () => {
    const { blockId, areaIds } = await seedCharted(a);
    await expect(
      asUser(a.userId, (q) =>
        q(
          `insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
           values ($1,$2,'Chin','bilateral',9)`,
          [blockId, a.studioId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(a.userId, (q) =>
        q("update public.session_block_areas set laterality='right' where id=$1", [areaIds[0]]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(a.userId, (q) =>
        q("delete from public.session_block_areas where id=$1", [areaIds[0]]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Nothing changed.
    expect(await areaSnapshot(blockId)).toHaveLength(2);
  });

  it("TRUNCATE — which RLS never protects — is denied for members and anon", async () => {
    await expect(
      asUser(a.userId, (q) => q("truncate table public.session_block_areas")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("anon", (q) => q("truncate table public.session_block_areas")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("anon holds no privilege at all on the table", async () => {
    await expect(
      asRole("anon", (q) => q("select 1 from public.session_block_areas limit 1")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  describe("on a FINALIZED session the guard binds every role, RLS-exempt included", () => {
    let ctx: { sessionId: string; blockId: string; areaIds: string[] };
    let otherDraftBlock: string;

    beforeAll(async () => {
      ctx = await seedCharted(a);
      await finalizeForReal(a, ctx.sessionId);
      otherDraftBlock = (await seedCharted(a)).blockId;
    });

    it("direct INSERT is denied", async () => {
      await expect(
        adminQuery(
          `insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
           values ($1,$2,'Neck','midline',7)`,
          [ctx.blockId, a.studioId],
        ),
      ).rejects.toThrow(FINALIZED_MSG);
      await expect(
        asRole("service_role", (q) =>
          q(
            `insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
             values ($1,$2,'Neck','midline',7)`,
            [ctx.blockId, a.studioId],
          ),
        ),
      ).rejects.toThrow(FINALIZED_MSG);
    });

    it("direct UPDATE of a value is denied", async () => {
      await expect(
        adminQuery("update public.session_block_areas set area='Jawline' where id=$1", [
          ctx.areaIds[0],
        ]),
      ).rejects.toThrow(FINALIZED_MSG);
      await expect(
        asRole("service_role", (q) =>
          q("update public.session_block_areas set laterality='bilateral' where id=$1", [
            ctx.areaIds[0],
          ]),
        ),
      ).rejects.toThrow(FINALIZED_MSG);
    });

    it("direct DELETE is denied", async () => {
      await expect(
        adminQuery("delete from public.session_block_areas where id=$1", [ctx.areaIds[0]]),
      ).rejects.toThrow(FINALIZED_MSG);
      await expect(
        asRole("service_role", (q) =>
          q("delete from public.session_block_areas where session_block_id=$1", [ctx.blockId]),
        ),
      ).rejects.toThrow(FINALIZED_MSG);
    });

    it("REASSIGNMENT out of the finalized record is denied", async () => {
      await expect(
        adminQuery("update public.session_block_areas set session_block_id=$2 where id=$1", [
          ctx.areaIds[0],
          otherDraftBlock,
        ]),
      ).rejects.toThrow(FINALIZED_MSG);
    });

    it("REASSIGNMENT into the finalized record is denied", async () => {
      const draftAreaId = (
        await adminQuery(
          "select id from public.session_block_areas where session_block_id=$1 limit 1",
          [otherDraftBlock],
        )
      ).rows[0].id as string;
      await expect(
        adminQuery("update public.session_block_areas set session_block_id=$2 where id=$1", [
          draftAreaId,
          ctx.blockId,
        ]),
      ).rejects.toThrow(FINALIZED_MSG);
    });

    it("REORDER is denied", async () => {
      await expect(
        adminQuery(
          "update public.session_block_areas set display_order = display_order + 10 where session_block_id=$1",
          [ctx.blockId],
        ),
      ).rejects.toThrow(FINALIZED_MSG);
    });

    it("the finalized record's authoritative areas are byte-for-byte unchanged", async () => {
      expect(await areaSnapshot(ctx.blockId)).toEqual([
        { area: "Cheek", laterality: "left", display_order: 0 },
        { area: "Sideburn", laterality: "right", display_order: 1 },
      ]);
    });

    it("a member can still READ them — the record is frozen, not hidden", async () => {
      // The whole point of preserving these rows is that the chart keeps showing
      // the areas actually treated. A policy narrowed to drafts would pass every
      // write-denial test above while silently blanking every finalized record.
      const rows = await asUser(a.userId, (q) =>
        q(
          `select area, laterality from public.session_block_areas
            where session_block_id=$1 order by display_order`,
          [ctx.blockId],
        ),
      );
      expect(rows.rows).toEqual([
        { area: "Cheek", laterality: "left" },
        { area: "Sideburn", laterality: "right" },
      ]);
    });
  });

  it("a VOID session is frozen exactly like a finalized one", async () => {
    const { sessionId, blockId, areaIds } = await seedCharted(a);
    await setStatus(sessionId, "void");
    await expect(
      adminQuery("update public.session_block_areas set laterality='bilateral' where id=$1", [
        areaIds[0],
      ]),
    ).rejects.toThrow(FINALIZED_MSG);
    await expect(
      adminQuery("delete from public.session_block_areas where id=$1", [areaIds[0]]),
    ).rejects.toThrow(FINALIZED_MSG);
    await expect(
      adminQuery(
        `insert into public.session_block_areas (session_block_id, studio_id, area, laterality)
         values ($1,$2,'Neck','midline')`,
        [blockId, a.studioId],
      ),
    ).rejects.toThrow(FINALIZED_MSG);
    expect(await areaSnapshot(blockId)).toHaveLength(2);
  });

  it("service_role cannot TRUNCATE the table (statement-level ops fire no row trigger)", async () => {
    // TRUNCATE consults no policy and fires no BEFORE ROW trigger, so the guard
    // cannot see it. 0158 therefore removes the privilege from service_role as
    // well as from the browser roles — otherwise a single statement would empty a
    // finalized record's authoritative areas with every signed field untouched.
    await expect(
      asRole("service_role", (q) => q("truncate table public.session_block_areas")),
    ).rejects.toMatchObject({ code: "42501" });
    for (const priv of ["TRUNCATE", "REFERENCES", "TRIGGER"] as const) {
      const r = await adminQuery(
        "select has_table_privilege('service_role','public.session_block_areas',$1) as ok",
        [priv],
      );
      expect({ priv, ok: r.rows[0].ok }).toEqual({ priv, ok: false });
    }
    // …while the row DML it legitimately needs is intact.
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      const r = await adminQuery(
        "select has_table_privilege('service_role','public.session_block_areas',$1) as ok",
        [priv],
      );
      expect({ priv, ok: r.rows[0].ok }).toEqual({ priv, ok: true });
    }
  });

  it("a status round-trip cannot reopen the write window (once finalized, always frozen)", async () => {
    // The 0120 correction permit lets a direct-connection caller UPDATE a
    // finalized sessions row — including record_status. Without the
    // finalization-evidence check, that would be an unfreeze -> rewrite -> re-freeze
    // path around the area guard, leaving the signed content_hash untouched.
    const { sessionId, blockId } = await seedCharted(a);
    await finalizeForReal(a, sessionId);
    const hashBefore = (
      await adminQuery(
        "select content_hash from public.clinical_record_snapshots where session_id=$1",
        [sessionId],
      )
    ).rows[0].content_hash as string;

    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('hone.correction_session_id', $1, true)", [sessionId]);
      // Step 1 — the 0120 permit really does allow the unfreeze. (If this ever
      // starts failing, 0120 tightened and this test's premise changed; the
      // assertion below is the one that matters.)
      await c.query("update public.sessions set record_status='draft' where id=$1", [sessionId]);
      // Step 2 — the rewrite must STILL be rejected on the finalization evidence.
      // Each probe runs inside its own savepoint so one rejection does not abort
      // the transaction and mask the next.
      await c.query("savepoint p1");
      await expect(
        c.query("update public.session_block_areas set area='TAMPERED' where session_block_id=$1", [
          blockId,
        ]),
      ).rejects.toThrow(/finalized and signed/i);
      await c.query("rollback to savepoint p1");
      // The trusted command is refused for the same reason. Run it as a real
      // studio member so the is_studio_member gate is satisfied and the rejection
      // provably comes from the lifecycle check. `set local role` / set_config are
      // reverted by the savepoint rollback; the correction GUC set before the
      // savepoint survives.
      await c.query("savepoint p2");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: a.userId, role: "authenticated" }),
      ]);
      await expect(
        c.query(
          "select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb,null)",
          [a.studioId, sessionId, blockId, AREAS([{ area: "Neck", laterality: "midline" }])],
        ),
      ).rejects.toThrow(/finalized and signed/i);
      await c.query("rollback to savepoint p2");
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }

    const after = await adminQuery(
      "select record_status, content_hash from public.sessions s join public.clinical_record_snapshots cs on cs.session_id = s.id where s.id=$1",
      [sessionId],
    );
    expect(after.rows[0].record_status).toBe("finalized");
    expect(after.rows[0].content_hash).toBe(hashBefore);
    expect((await areaSnapshot(blockId)).map((r) => r.area)).toEqual(["Cheek", "Sideburn"]);
  });

  it("a studio_id-only UPDATE cannot re-tenant a draft area row (0128 derive widened)", async () => {
    const { blockId, areaIds } = await seedCharted(a);
    await adminQuery("update public.session_block_areas set studio_id=$2 where id=$1", [
      areaIds[0],
      b.studioId,
    ]);
    const row = await adminQuery(
      "select studio_id from public.session_block_areas where id=$1",
      [areaIds[0]],
    );
    expect(row.rows[0].studio_id).toBe(a.studioId); // derived back from the parent block
    expect(await areaSnapshot(blockId)).toHaveLength(2);
  });

  it("a SOFT-DELETED draft parent: DELETE is still allowed, INSERT/UPDATE are not", async () => {
    // This is the entire reason the guard has two lifecycle asserts. Ordinary
    // cleanup of a soft-deleted draft must keep working (p_allow_deleted = true on
    // DELETE), while nothing may be added to or edited on it.
    const { sessionId, blockId, areaIds } = await seedCharted(a);
    await adminQuery("update public.sessions set deleted_at = now() where id=$1", [sessionId]);
    await expect(
      adminQuery("update public.session_block_areas set laterality='bilateral' where id=$1", [
        areaIds[0],
      ]),
    ).rejects.toThrow(/deleted/i);
    await expect(
      adminQuery(
        `insert into public.session_block_areas (session_block_id, studio_id, area, laterality)
         values ($1,$2,'Neck','midline')`,
        [blockId, a.studioId],
      ),
    ).rejects.toThrow(/deleted/i);
    // …and the DELETE succeeds.
    await adminQuery("delete from public.session_block_areas where id=$1", [areaIds[0]]);
    expect(await areaSnapshot(blockId)).toHaveLength(1);
  });

  it("the guard carries NO correction-context bypass (structured areas have no correction path yet)", async () => {
    const { sessionId, blockId, areaIds } = await seedCharted(a);
    await finalizeForReal(a, sessionId);
    // Set the 0120 trusted-correction GUC to this exact session — the permit that
    // unfreezes sessions/session_blocks/entries — and prove it grants nothing here.
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('hone.correction_session_id', $1, true)", [sessionId]);
      await expect(
        c.query("update public.session_block_areas set area='Jawline' where id=$1", [areaIds[0]]),
      ).rejects.toThrow(FINALIZED_MSG);
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
    expect(await areaSnapshot(blockId)).toHaveLength(2);
  });

  it("a status round-trip cannot ERASE areas by deleting the parent block either", async () => {
    // REVIEW FINDING. The area guard's DELETE branch returns early when the parent
    // block is already gone (the FK cascade path), and 0119's session_blocks DELETE
    // branch inspects only sessions.record_status. So without the extra
    // session_blocks guard, the same 0120-permit status round-trip could delete the
    // BLOCK and erase a signed record's areas by cascade, below the area guard.
    const { sessionId, blockId } = await seedCharted(a);
    await finalizeForReal(a, sessionId);

    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('hone.correction_session_id', $1, true)", [sessionId]);
      await c.query("update public.sessions set record_status='draft' where id=$1", [sessionId]);
      await expect(
        c.query("delete from public.session_blocks where id=$1", [blockId]),
      ).rejects.toThrow(/finalized and signed/i);
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
    expect(await areaSnapshot(blockId)).toHaveLength(2);
  });

  it("a status round-trip cannot REPARENT a block into (or out of) a signed record", async () => {
    // REVIEW FINDING, reproduced: moving a block carries its whole structured-area
    // set and writes NO session_block_areas row, so the area guard never fires;
    // 0119's child UPDATE branch compares only record_status at the two endpoints,
    // which the 0120 permit round-trips to 'draft'. Before the fix a signed
    // record's area count went 2 -> 4 with its content_hash byte-identical.
    const { sessionId: signedId, blockId: signedBlock } = await seedCharted(a);
    await finalizeForReal(a, signedId);
    const donor = await seedCharted(a); // a draft block carrying two areas
    const hashBefore = (
      await adminQuery(
        "select content_hash from public.clinical_record_snapshots where session_id=$1",
        [signedId],
      )
    ).rows[0].content_hash as string;

    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('hone.correction_session_id', $1, true)", [signedId]);
      await c.query("update public.sessions set record_status='draft' where id=$1", [signedId]);
      // …move the donor block INTO the signed record.
      await c.query("savepoint r1");
      await expect(
        c.query("update public.session_blocks set session_id=$2 where id=$1", [
          donor.blockId,
          signedId,
        ]),
      ).rejects.toThrow(/finalized and signed/i);
      await c.query("rollback to savepoint r1");
      // …and move the signed record's own block OUT.
      await c.query("savepoint r2");
      await expect(
        c.query("update public.session_blocks set session_id=$2 where id=$1", [
          signedBlock,
          donor.sessionId,
        ]),
      ).rejects.toThrow(/finalized and signed/i);
      await c.query("rollback to savepoint r2");
      // …and attach a brand-new block to it.
      await c.query("savepoint r3");
      await expect(
        c.query(
          "insert into public.session_blocks (id, studio_id, session_id, sort_order) values ($1,$2,$3,9)",
          [randomUUID(), a.studioId, signedId],
        ),
      ).rejects.toThrow(/finalized and signed/i);
      await c.query("rollback to savepoint r3");
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }

    const after = await adminQuery(
      `select count(*)::int n from public.session_block_areas a
         join public.session_blocks b on b.id = a.session_block_id
        where b.session_id = $1`,
      [signedId],
    );
    expect(after.rows[0].n).toBe(2);
    expect(
      (
        await adminQuery(
          "select content_hash from public.clinical_record_snapshots where session_id=$1",
          [signedId],
        )
      ).rows[0].content_hash,
    ).toBe(hashBefore);
  });

  it("a status round-trip cannot SOFT-DELETE the parent block of a signed record", async () => {
    // REVIEW FINDING, reproduced as plain `authenticated`: every read surface
    // filters `deleted_at is null` — getSessionBlocks, the Before Today preview,
    // the studio data export and build_session_snapshot itself — so flipping
    // deleted_at on a signed record's block makes its authoritative areas vanish
    // from the chart, history and export without deleting a single row. The 0123
    // RPC path was already closed; this is the raw UPDATE.
    const { sessionId, blockId } = await seedCharted(a);
    await finalizeForReal(a, sessionId);

    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: a.userId, role: "authenticated" }),
      ]);
      await c.query("select set_config('hone.correction_session_id', $1, true)", [sessionId]);
      await expect(
        c.query("update public.session_blocks set deleted_at = now() where id=$1", [blockId]),
      ).rejects.toThrow(/finalized and signed/i);
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
    // The trusted removal RPC is refused too (0123 already did this; keep it pinned).
    await expect(
      userQuery(a.userId, "select * from public.soft_delete_session_area($1,$2,$3)", [
        sessionId,
        blockId,
        "removing this area for a test reason",
      ]),
    ).rejects.toThrow();
    const live = await adminQuery(
      "select count(*)::int n from public.session_blocks where id=$1 and deleted_at is null",
      [blockId],
    );
    expect(live.rows[0].n).toBe(1);
    expect(await areaSnapshot(blockId)).toHaveLength(2);
  });

  it("soft-deleting a NEVER-SIGNED draft's block still works (0123 path intact)", async () => {
    const { sessionId, blockId } = await seedCharted(a);
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
      [randomUUID(), sessionId, blockId],
    );
    await userQuery(a.userId, "select * from public.soft_delete_session_area($1,$2,$3)", [
      sessionId,
      blockId,
      "removing this area for a test reason",
    ]);
    const row = await adminQuery(
      "select deleted_at is not null as gone from public.session_blocks where id=$1",
      [blockId],
    );
    expect(row.rows[0].gone).toBe(true);
  });

  it("ordinary charting UPDATEs on session_blocks are untouched by that guard", async () => {
    // The reparent guard must only bite on a genuine session_id move.
    const { sessionId, blockId } = await seedCharted(a);
    await userQuery(a.userId, UPDATE_RPC, [
      a.studioId,
      sessionId,
      blockId,
      JSON.stringify({ mode: "blend", energy_level: 14 }),
      AREAS([{ area: "Chin", laterality: "left" }]),
      null,
    ]);
    const row = await adminQuery(
      "select mode, energy_level from public.session_blocks where id=$1",
      [blockId],
    );
    expect(row.rows[0].mode).toBe("blend");
    // …and a block still moves freely between two never-signed drafts.
    const other = await seedSession(a);
    await adminQuery("update public.session_blocks set session_id=$2 where id=$1", [
      blockId,
      other.sessionId,
    ]);
    expect(
      (
        await adminQuery("select session_id from public.session_blocks where id=$1", [blockId])
      ).rows[0].session_id,
    ).toBe(other.sessionId);
  });

  it("the FK cascade cleanup path still works for a draft (delete is not wedged)", async () => {
    const { sessionId, blockId } = await seedCharted(a);
    await adminQuery("delete from public.session_blocks where id=$1", [blockId]);
    expect(await areaSnapshot(blockId)).toHaveLength(0);
    // …and deleting the whole draft encounter cascades cleanly too.
    const second = await seedCharted(a);
    await adminQuery("delete from public.sessions where id=$1", [second.sessionId]);
    expect(await areaSnapshot(second.blockId)).toHaveLength(0);
    expect(sessionId).toBeTruthy();
  });
});

// ===========================================================================
// B. Trusted command behaviour.
// ===========================================================================
describe("B. trusted charting commands", () => {
  it("DRAFT: create succeeds and records multi-area + per-area laterality", async () => {
    const { sessionId } = await seedSession(a);
    const blockId = (
      await userQuery(a.userId, CREATE_RPC, [
        a.studioId,
        sessionId,
        JSON.stringify({ primary_area: "Cheeks", side: "left", mode: "blend" }),
        AREAS([
          { area: "Cheeks", laterality: "left" },
          { area: "Cheeks", laterality: "right" },
          { area: "Chin", laterality: "midline" },
        ]),
      ])
    ).rows[0].id as string;
    expect(await areaSnapshot(blockId)).toEqual([
      { area: "Cheeks", laterality: "left", display_order: 0 },
      { area: "Cheeks", laterality: "right", display_order: 1 },
      { area: "Chin", laterality: "midline", display_order: 2 },
    ]);
    const blk = await adminQuery(
      "select primary_area, side, mode from public.session_blocks where id=$1",
      [blockId],
    );
    expect(blk.rows[0]).toMatchObject({ primary_area: "Cheeks", side: "left", mode: "blend" });
  });

  it("DRAFT: replace succeeds and the whole set is canonical", async () => {
    const { sessionId, blockId } = await seedCharted(a);
    await userQuery(a.userId, UPDATE_RPC, [
      a.studioId,
      sessionId,
      blockId,
      "{}",
      AREAS([{ area: "Neck", laterality: "midline" }]),
      null,
    ]);
    expect(await areaSnapshot(blockId)).toEqual([
      { area: "Neck", laterality: "midline", display_order: 0 },
    ]);
  });

  it("FINALIZED: create fails, replace fails, and NOTHING changes", async () => {
    const { sessionId, blockId } = await seedCharted(a);
    await finalizeForReal(a, sessionId);
    const areasBefore = await areaSnapshot(blockId);
    const blocksBefore = await adminQuery(
      "select id, primary_area, side, mode, minutes_performed from public.session_blocks where session_id=$1 order by sort_order",
      [sessionId],
    );
    const entriesBefore = await adminQuery(
      "select id, area, block_id from public.electrolysis_entries where session_id=$1 order by id",
      [sessionId],
    );

    // Pin the 0158 PREAMBLE's own wording, not 0119's. Both RPCs also touch
    // session_blocks, whose 0119 guard raises a message that matches the generic
    // /finalized and read-only/ pattern — so asserting only that would leave the
    // new assert_session_chartable call unproven.
    const RPC_PREAMBLE_MSG = /Treatment areas and laterality cannot be changed after finalization/;
    await expect(
      userQuery(a.userId, CREATE_RPC, [
        a.studioId,
        sessionId,
        JSON.stringify({ primary_area: "Neck" }),
        AREAS([{ area: "Neck", laterality: "midline" }]),
      ]),
    ).rejects.toThrow(RPC_PREAMBLE_MSG);

    await expect(
      userQuery(a.userId, UPDATE_RPC, [
        a.studioId,
        sessionId,
        blockId,
        JSON.stringify({ mode: "galvanic", minutes_performed: 99 }),
        AREAS([{ area: "Neck", laterality: "midline" }]),
        null,
      ]),
    ).rejects.toThrow(RPC_PREAMBLE_MSG);

    expect(await areaSnapshot(blockId)).toEqual(areasBefore);
    expect(
      (
        await adminQuery(
          "select id, primary_area, side, mode, minutes_performed from public.session_blocks where session_id=$1 order by sort_order",
          [sessionId],
        )
      ).rows,
    ).toEqual(blocksBefore.rows);
    expect(
      (
        await adminQuery(
          "select id, area, block_id from public.electrolysis_entries where session_id=$1 order by id",
          [sessionId],
        )
      ).rows,
    ).toEqual(entriesBefore.rows);
  });

  it("VOID: create and replace both fail", async () => {
    const { sessionId, blockId } = await seedCharted(a);
    await setStatus(sessionId, "void");
    await expect(
      userQuery(a.userId, CREATE_RPC, [a.studioId, sessionId, "{}", AREAS([])]),
    ).rejects.toThrow(FINALIZED_MSG);
    await expect(
      userQuery(a.userId, UPDATE_RPC, [a.studioId, sessionId, blockId, "{}", AREAS([]), null]),
    ).rejects.toThrow(FINALIZED_MSG);
    expect(await areaSnapshot(blockId)).toHaveLength(2);
  });

  it("SOFT-DELETED draft: create and replace both fail", async () => {
    const { sessionId, blockId } = await seedCharted(a);
    await adminQuery("update public.sessions set deleted_at = now() where id=$1", [sessionId]);
    await expect(
      userQuery(a.userId, CREATE_RPC, [a.studioId, sessionId, "{}", AREAS([])]),
    ).rejects.toThrow(/deleted/i);
    await expect(
      userQuery(a.userId, UPDATE_RPC, [a.studioId, sessionId, blockId, "{}", AREAS([]), null]),
    ).rejects.toThrow(/deleted/i);
    expect(await areaSnapshot(blockId)).toHaveLength(2);
  });

  it("the optimistic-concurrency contract is preserved verbatim", async () => {
    const { sessionId, blockId } = await seedCharted(a);
    const v0 = (
      await adminQuery("select updated_at::text as v from public.session_blocks where id=$1", [
        blockId,
      ])
    ).rows[0].v as string;
    await userQuery(a.userId, UPDATE_RPC, [
      a.studioId,
      sessionId,
      blockId,
      "{}",
      AREAS([{ area: "Chin", laterality: "left" }]),
      v0,
    ]);
    await expect(
      userQuery(a.userId, UPDATE_RPC, [
        a.studioId,
        sessionId,
        blockId,
        "{}",
        AREAS([{ area: "Neck", laterality: "left" }]),
        v0,
      ]),
    ).rejects.toThrow(/stale_block_version/);
    expect((await areaSnapshot(blockId)).map((r) => r.area)).toEqual(["Chin"]);
  });
});

// ===========================================================================
// C. Role / grant matrix — table privileges and function EXECUTE, separately.
// ===========================================================================
describe("C. role and grant matrix", () => {
  const PRIVS = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
  ] as const;

  it("table privileges: PUBLIC and anon hold nothing; authenticated holds SELECT only", async () => {
    const rows = (
      await adminQuery(
        `select r as role, p as priv, has_table_privilege(r, 'public.session_block_areas', p) as ok
           from unnest($1::text[]) r, unnest($2::text[]) p`,
        [["public", "anon", "authenticated"], [...PRIVS]],
      )
    ).rows as Array<{ role: string; priv: string; ok: boolean }>;
    for (const row of rows) {
      const expected = row.role === "authenticated" && row.priv === "SELECT";
      expect({ ...row, ok: row.ok }).toEqual({ ...row, ok: expected });
    }
  });

  it("table privileges: service_role keeps DML — the trigger, not the grant, contains it", async () => {
    const rows = (
      await adminQuery(
        `select p as priv, has_table_privilege('service_role', 'public.session_block_areas', p) as ok
           from unnest($1::text[]) p`,
        [["SELECT", "INSERT", "UPDATE", "DELETE"]],
      )
    ).rows as Array<{ priv: string; ok: boolean }>;
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it("exactly one policy remains, and it is SELECT-only for authenticated", async () => {
    const rows = (
      await adminQuery(
        `select polname, polcmd::text as polcmd,
                (select coalesce(string_agg(rolname,'+'),'PUBLIC') from pg_roles where oid = any(polroles)) as roles
           from pg_policy where polrelid = 'public.session_block_areas'::regclass`,
      )
    ).rows;
    expect(rows).toEqual([
      { polname: "session_block_areas_member_select", polcmd: "r", roles: "authenticated" },
    ]);
  });

  it("function EXECUTE: the charting RPCs stay callable; the internal asserts do not", async () => {
    const rows = (
      await adminQuery(
        `select f as fn, r as role, has_function_privilege(r, f, 'EXECUTE') as ok
           from unnest($1::text[]) f, unnest($2::text[]) r`,
        [
          [
            "public.create_session_block_with_areas(uuid,uuid,jsonb,jsonb)",
            "public.update_session_block_with_areas(uuid,uuid,uuid,jsonb,jsonb,timestamptz)",
            "public.assert_session_chartable(uuid,uuid)",
            "public.assert_structured_area_parent_mutable(uuid,boolean)",
          ],
          ["anon", "authenticated", "service_role"],
        ],
      )
    ).rows as Array<{ fn: string; role: string; ok: boolean }>;
    const at = (fn: string, role: string) =>
      rows.find((r) => r.fn.startsWith(fn) && r.role === role)!.ok;
    expect(at("public.create_session_block_with_areas", "anon")).toBe(false);
    expect(at("public.create_session_block_with_areas", "authenticated")).toBe(true);
    expect(at("public.create_session_block_with_areas", "service_role")).toBe(true);
    expect(at("public.update_session_block_with_areas", "anon")).toBe(false);
    expect(at("public.update_session_block_with_areas", "authenticated")).toBe(true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(at("public.assert_session_chartable", role)).toBe(false);
      expect(at("public.assert_structured_area_parent_mutable", role)).toBe(false);
    }
  });

  it("the guard trigger is attached BEFORE insert, update AND delete, for each row", async () => {
    const r = await adminQuery(
      `select tgname, tgtype from pg_trigger
        where tgrelid='public.session_block_areas'::regclass and not tgisinternal
        order by tgname`,
    );
    const guard = r.rows.find((x) => x.tgname === "session_block_areas_guard_finalized");
    expect(guard).toBeDefined();
    // tgtype bitmask: ROW(1) | BEFORE(2) | INSERT(4) | DELETE(8) | UPDATE(16) = 31.
    expect(Number(guard!.tgtype) & 1).toBe(1);
    expect(Number(guard!.tgtype) & 2).toBe(2);
    expect(Number(guard!.tgtype) & 4).toBe(4);
    expect(Number(guard!.tgtype) & 8).toBe(8);
    expect(Number(guard!.tgtype) & 16).toBe(16);
  });
});

// ===========================================================================
// D. Tenant isolation and same-studio wrong-record lineage.
// ===========================================================================
describe("D. tenant isolation and lineage", () => {
  it("a same-studio valid draft succeeds through the command", async () => {
    const { sessionId } = await seedSession(a);
    const id = await userQuery(a.userId, CREATE_RPC, [
      a.studioId,
      sessionId,
      "{}",
      AREAS([{ area: "Chin", laterality: "left" }]),
    ]);
    expect(id.rows[0].id).toBeTruthy();
  });

  it("a cross-studio block id fails", async () => {
    const other = await seedCharted(b);
    await expect(
      userQuery(a.userId, UPDATE_RPC, [
        a.studioId,
        other.sessionId,
        other.blockId,
        "{}",
        AREAS([{ area: "Chin", laterality: "left" }]),
        null,
      ]),
    ).rejects.toThrow(/not found/i);
    expect((await areaSnapshot(other.blockId)).length).toBe(2);
  });

  it("a forged p_studio_id cannot re-tenant a session or its rows", async () => {
    const mine = await seedCharted(a);
    // Studio A's member naming studio B: the membership gate rejects outright.
    await expect(
      userQuery(a.userId, UPDATE_RPC, [
        b.studioId,
        mine.sessionId,
        mine.blockId,
        "{}",
        AREAS([{ area: "Chin", laterality: "left" }]),
        null,
      ]),
    ).rejects.toThrow(/not authorized/i);
    // Studio B's member naming studio B but pointing at studio A's session: the
    // server-derived studio on the stored row does not match, so it is not found.
    await expect(
      userQuery(b.userId, UPDATE_RPC, [
        b.studioId,
        mine.sessionId,
        mine.blockId,
        "{}",
        AREAS([{ area: "Chin", laterality: "left" }]),
        null,
      ]),
    ).rejects.toThrow(/not found/i);
    const rows = await adminQuery(
      "select distinct studio_id from public.session_block_areas where session_block_id=$1",
      [mine.blockId],
    );
    expect(rows.rows).toEqual([{ studio_id: a.studioId }]);
  });

  it("a wrong-session lineage inside the SAME studio fails", async () => {
    const one = await seedCharted(a);
    const two = await seedCharted(a);
    // Block from session `one`, session id from session `two` — same studio.
    await expect(
      userQuery(a.userId, UPDATE_RPC, [
        a.studioId,
        two.sessionId,
        one.blockId,
        "{}",
        AREAS([{ area: "Chin", laterality: "left" }]),
        null,
      ]),
    ).rejects.toThrow(/not found/i);
    expect((await areaSnapshot(one.blockId)).map((r) => r.area)).toEqual(["Cheek", "Sideburn"]);
    expect((await areaSnapshot(two.blockId)).map((r) => r.area)).toEqual(["Cheek", "Sideburn"]);
  });

  it("a cross-studio direct write is denied at the privilege layer before RLS is even consulted", async () => {
    const mine = await seedCharted(a);
    await expect(
      asUser(b.userId, (q) =>
        q(
          `insert into public.session_block_areas (session_block_id, studio_id, area, laterality)
           values ($1,$2,'Chin','left')`,
          [mine.blockId, b.studioId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

// ===========================================================================
// F. Adjacent workflows must keep working — a finalized record is frozen for
//    WRITES, not for READS, and whole-session copy reads finalized sources.
// ===========================================================================
describe("F. whole-session copy still reads a FINALIZED source", () => {
  it("copies a finalized session's structured areas into a draft target, source untouched", async () => {
    const studio = await seedStudio("fsac-copy");
    const clientId = randomUUID();
    await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Copy')", [
      clientId,
      studio.studioId,
    ]);

    // Source: an electrolysis draft with a block + structured areas + one entry,
    // then finalized for real.
    const sourceId = randomUUID();
    await adminQuery(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, record_status, started_at)
       values ($1,$2,$3,$4,'electrolysis','draft','2026-01-01T10:00:00Z')`,
      [sourceId, studio.studioId, clientId, studio.practitionerId],
    );
    const sourceBlock = (
      await userQuery(studio.userId, CREATE_RPC, [
        studio.studioId,
        sourceId,
        JSON.stringify({ primary_area: "Chin", side: "left", mode: "blend", energy_level: 12 }),
        AREAS([{ area: "Chin", laterality: "left" }]),
      ])
    ).rows[0].id as string;
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
      [randomUUID(), sourceId, sourceBlock],
    );
    await adminQuery(
      "update public.studios set clinical_finalization_enabled = true where id=$1",
      [studio.studioId],
    );
    await userQuery(studio.userId, "select * from public.finalize_session($1,$2)", [sourceId, 1]);

    // Target: a later, empty electrolysis draft for the same client.
    const targetId = randomUUID();
    await adminQuery(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, record_status, started_at)
       values ($1,$2,$3,$4,'electrolysis','draft','2026-06-01T10:00:00Z')`,
      [targetId, studio.studioId, clientId, studio.practitionerId],
    );

    const derived = (
      await adminQuery("select public._whole_session_copy_source_id($1,$2) as id", [
        studio.studioId,
        targetId,
      ])
    ).rows[0].id as string;
    expect(derived).toBe(sourceId); // a finalized session is a valid historical source

    const fp = (
      await adminQuery("select public._whole_session_copy_fingerprint($1) as fp", [sourceId])
    ).rows[0].fp as string;
    const specs = JSON.stringify([
      {
        block: { mode: "blend", energy_level: 12, primary_area: "Chin", side: "left" },
        areas: [{ area: "Chin", laterality: "left", display_order: 0 }],
        entry: { area: "Chin", areas: ["Chin"], mode: "blend" },
      },
    ]);
    await adminQuery("select public.copy_session_setup($1,$2,$3,$4::jsonb,$5,$6,$7) as result", [
      studio.studioId,
      targetId,
      studio.practitionerId,
      specs,
      randomUUID(),
      fp,
      sourceId,
    ]);

    const targetBlock = (
      await adminQuery(
        "select id from public.session_blocks where session_id=$1 and deleted_at is null",
        [targetId],
      )
    ).rows[0].id as string;
    expect((await areaSnapshot(targetBlock)).map((r) => r.area)).toEqual(["Chin"]);
    // The finalized source is byte-for-byte unchanged.
    expect(await areaSnapshot(sourceBlock)).toEqual([
      { area: "Chin", laterality: "left", display_order: 0 },
    ]);
  });
});

// ===========================================================================
// E. Real two-connection concurrency against finalization.
// ===========================================================================
describe("E. area write versus finalization (two real connections)", () => {
  async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    await c.query("set statement_timeout = '20s'");
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Run a statement as an authenticated app user on a dedicated connection so the
  // transaction can be held open across a barrier.
  async function beginAsUser(c: Client, userId: string): Promise<void> {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
  }

  it("area write FIRST: finalization waits, then finalizes the post-write state — never both", async () => {
    const studio = await seedStudio("fsac-c1");
    const { sessionId, blockId } = await seedCharted(studio);
    await adminQuery(
      "update public.studios set clinical_finalization_enabled = true where id=$1",
      [studio.studioId],
    );
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
      [randomUUID(), sessionId, blockId],
    );

    await withClient(async (writer) => {
      await withClient(async (finalizer) => {
        // 1. The area write starts and HOLDS the parent-session lock.
        await beginAsUser(writer, studio.userId);
        const writerPid = (await writer.query("select pg_backend_pid() as pid")).rows[0]
          .pid as number;
        await writer.query(UPDATE_RPC, [
          studio.studioId,
          sessionId,
          blockId,
          "{}",
          AREAS([{ area: "Neck", laterality: "midline" }]),
          null,
        ]);

        // 2. Finalization attempts concurrently — it must block on that lock.
        await beginAsUser(finalizer, studio.userId);
        const finalizerPid = (await finalizer.query("select pg_backend_pid() as pid")).rows[0]
          .pid as number;
        const finalizePromise = finalizer
          .query("select * from public.finalize_session($1,$2)", [sessionId, 1])
          .then((r) => ({ ok: true as const, row: r.rows[0] }))
          .catch((e) => ({ ok: false as const, error: e }));

        // Prove it is genuinely waiting on THIS writer, not racing past or
        // blocked by some unrelated backend on a shared local stack: poll
        // pg_blocking_pids for the finalizer's own backend pid until it contains
        // the writer's pid.
        let blockedByWriter = false;
        for (let i = 0; i < 100 && !blockedByWriter; i++) {
          const r = await adminQuery(
            "select pg_blocking_pids($1) @> array[$2::int] as blocked",
            [finalizerPid, writerPid],
          );
          blockedByWriter = r.rows[0].blocked === true;
          if (!blockedByWriter) await new Promise((r2) => setTimeout(r2, 50));
        }
        expect(blockedByWriter).toBe(true);

        await writer.query("commit");
        const result = await finalizePromise;
        await finalizer.query("commit").catch(() => undefined);

        // 3. Exactly one legal ordering: the write landed, THEN the record froze.
        expect(result.ok).toBe(true);
        expect((result as { ok: true; row: { already_finalized: boolean } }).row.already_finalized).toBe(false);
        expect((await areaSnapshot(blockId)).map((r) => r.area)).toEqual(["Neck"]);
        const s = await adminQuery("select record_status from public.sessions where id=$1", [
          sessionId,
        ]);
        expect(s.rows[0].record_status).toBe("finalized");
        // 4. The record is frozen, so no further area movement is possible. Note
        //    what this does NOT say: the signed artifact still does not cover these
        //    rows — build_session_snapshot serializes only the legacy projection.
        //    Tamper-EVIDENCE requires snapshot v2; 0158 only closes the write path.
        await expect(
          adminQuery("update public.session_block_areas set area='Jawline' where session_block_id=$1", [
            blockId,
          ]),
        ).rejects.toThrow(FINALIZED_MSG);
      });
    });
  });

  it("the GUARD's own lock serializes a DIRECT area write against finalization", async () => {
    // REVIEW FINDING. The two orderings above both drive the area write through
    // update_session_block_with_areas, which takes the session lock in its 0158
    // PREAMBLE — so they would still pass if the lock were removed from the guard
    // trigger itself. This case bypasses the RPC entirely: a direct UPDATE on a
    // DRAFT parent's area rows, held uncommitted, must block a concurrent
    // finalize_session. Only the trigger can produce that lock.
    const studio = await seedStudio("fsac-trg");
    const { sessionId, blockId } = await seedCharted(studio);
    await adminQuery(
      "update public.studios set clinical_finalization_enabled = true where id=$1",
      [studio.studioId],
    );
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
      [randomUUID(), sessionId, blockId],
    );

    await withClient(async (writer) => {
      await withClient(async (finalizer) => {
        // Direct DML as the table owner — no RPC, so no preamble lock.
        await writer.query("begin");
        const writerPid = (await writer.query("select pg_backend_pid() as pid")).rows[0]
          .pid as number;
        await writer.query(
          "update public.session_block_areas set display_order = display_order + 1 where session_block_id=$1",
          [blockId],
        );

        await beginAsUser(finalizer, studio.userId);
        const finalizerPid = (await finalizer.query("select pg_backend_pid() as pid")).rows[0]
          .pid as number;
        const finalizePromise = finalizer
          .query("select * from public.finalize_session($1,$2)", [sessionId, 1])
          .then(() => ({ ok: true as const }))
          .catch((e) => ({ ok: false as const, error: e as { code?: string } }));

        let blockedByWriter = false;
        for (let i = 0; i < 100 && !blockedByWriter; i++) {
          const r = await adminQuery(
            "select pg_blocking_pids($1) @> array[$2::int] as blocked",
            [finalizerPid, writerPid],
          );
          blockedByWriter = r.rows[0].blocked === true;
          if (!blockedByWriter) await new Promise((r2) => setTimeout(r2, 50));
        }
        expect(blockedByWriter).toBe(true); // the GUARD's lock, nothing else

        await writer.query("commit");
        const result = await finalizePromise;
        await finalizer.query("commit").catch(() => undefined);
        expect(result.ok).toBe(true);
        if (!result.ok) expect(result.error.code).not.toBe("40P01");
      });
    });
  });

  it("block DELETE cannot race finalization (the block guard locks the parent too)", async () => {
    // REVIEW FINDING. session_has_been_signed is a plain read, so without a lock
    // the block guard is TOCTOU: a DELETE that samples "not signed" a moment before
    // finalize_session commits its snapshot proceeds anyway, and the signed record
    // loses the areas its own snapshot recorded — content_hash byte-identical.
    // The guard takes FOR KEY SHARE, which conflicts with finalization's FOR UPDATE.
    const studio = await seedStudio("fsac-race");
    const { sessionId, blockId } = await seedCharted(studio);
    await adminQuery(
      "update public.studios set clinical_finalization_enabled = true where id=$1",
      [studio.studioId],
    );
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
      [randomUUID(), sessionId, blockId],
    );

    await withClient(async (finalizer) => {
      await withClient(async (deleter) => {
        // Finalization takes the session FOR UPDATE and holds it uncommitted.
        await beginAsUser(finalizer, studio.userId);
        const finalizerPid = (await finalizer.query("select pg_backend_pid() as pid")).rows[0]
          .pid as number;
        await finalizer.query("select * from public.finalize_session($1,$2)", [sessionId, 1]);

        // The block DELETE must WAIT on that lock, not sample a stale answer.
        await deleter.query("begin");
        const deleterPid = (await deleter.query("select pg_backend_pid() as pid")).rows[0]
          .pid as number;
        const delPromise = deleter
          .query("delete from public.session_blocks where id=$1", [blockId])
          .then(() => ({ ok: true as const }))
          .catch((e) => ({ ok: false as const, error: e as { code?: string; message: string } }));

        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          const r = await adminQuery(
            "select pg_blocking_pids($1) @> array[$2::int] as blocked",
            [deleterPid, finalizerPid],
          );
          blocked = r.rows[0].blocked === true;
          if (!blocked) await new Promise((x) => setTimeout(x, 50));
        }
        expect(blocked).toBe(true);

        await finalizer.query("commit");
        const result = await delPromise;
        await deleter.query("rollback").catch(() => undefined);

        expect(result.ok).toBe(false);
        const err = (result as { ok: false; error: { code?: string; message: string } }).error;
        expect(err.message).toMatch(/finalized and signed/i);
        expect(err.code).not.toBe("40P01");
        // The signed record kept its areas.
        expect(await areaSnapshot(blockId)).toHaveLength(2);
      });
    });
  });

  it("area save vs area removal: the 0123 lock sequence does not deadlock", async () => {
    // REGRESSION. soft_delete_session_area (0123) locks a session_blocks row FIRST
    // (`for update of b`) and only later inserts its session_audit row, which needs
    // FOR KEY SHARE on the parent session. 0158 makes the charting RPCs lock the
    // session first — so if that lock were `for update` (which conflicts with FOR
    // KEY SHARE) the two deployed charting actions would deadlock (reproduced:
    // SQLSTATE 40P01). `for no key update` still excludes finalization but is
    // compatible with the child-insert lock, so the cycle does not exist.
    // The two halves of 0123's sequence are issued explicitly here because the
    // interleaving has to be deterministic; the lock modes are identical to the
    // ones the real RPC takes.
    const studio = await seedStudio("fsac-dl");
    const { sessionId, blockId } = await seedCharted(studio);

    await withClient(async (remover) => {
      await withClient(async (saver) => {
        await beginAsUser(remover, studio.userId);
        await beginAsUser(saver, studio.userId);

        // 1. The remover takes the BLOCK lock (0123 step 1).
        await remover.query("select b.id from public.session_blocks b where b.id=$1 for update", [
          blockId,
        ]);

        // 2. The saver takes the SESSION lock, then waits for the block lock.
        const savePromise = saver
          .query(UPDATE_RPC, [
            studio.studioId,
            sessionId,
            blockId,
            "{}",
            AREAS([{ area: "Neck", laterality: "midline" }]),
            null,
          ])
          .then(() => ({ ok: true as const }))
          .catch((e) => ({ ok: false as const, error: e as { code?: string; message: string } }));
        await new Promise((r) => setTimeout(r, 600));

        // 3. The remover now needs FOR KEY SHARE on the same session (0123 step 4,
        //    the session_audit insert). Under `for update` this closed the cycle.
        const auditPromise = remover
          .query(
            `insert into public.session_audit (session_id, edited_by_practitioner_id, field, old_value, new_value)
             values ($1,$2,'area_removed','x','a reason long enough')`,
            [sessionId, studio.practitionerId],
          )
          .then(() => ({ ok: true as const }))
          .catch((e) => ({ ok: false as const, error: e as { code?: string; message: string } }));

        const auditResult = await auditPromise;
        expect(auditResult.ok).toBe(true); // not blocked, not deadlocked
        await remover.query("commit");

        const saveResult = await savePromise;
        for (const r of [auditResult, saveResult]) {
          if (!r.ok) expect(r.error.code).not.toBe("40P01");
        }
        expect(saveResult.ok).toBe(true);
        await saver.query("commit");
        expect((await areaSnapshot(blockId)).map((r) => r.area)).toEqual(["Neck"]);
      });
    });
  });

  it("finalization FIRST: the area write blocks, then fails — no deadlock, no partial write", async () => {
    const studio = await seedStudio("fsac-c2");
    const { sessionId, blockId } = await seedCharted(studio);
    await adminQuery(
      "update public.studios set clinical_finalization_enabled = true where id=$1",
      [studio.studioId],
    );
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
      [randomUUID(), sessionId, blockId],
    );

    await withClient(async (finalizer) => {
      await withClient(async (writer) => {
        // 1. Finalization takes the session lock first and holds it uncommitted.
        await beginAsUser(finalizer, studio.userId);
        await finalizer.query("select * from public.finalize_session($1,$2)", [sessionId, 1]);

        // 2. The area write attempts concurrently and must WAIT on the same lock.
        await beginAsUser(writer, studio.userId);
        const writePromise = writer
          .query(UPDATE_RPC, [
            studio.studioId,
            sessionId,
            blockId,
            "{}",
            AREAS([{ area: "Neck", laterality: "midline" }]),
            null,
          ])
          .then(() => ({ ok: true as const }))
          .catch((e) => ({ ok: false as const, error: e as { message: string; code?: string } }));

        await new Promise((r) => setTimeout(r, 750));
        await finalizer.query("commit");
        const result = await writePromise;
        await writer.query("rollback").catch(() => undefined);

        // 3. The write is rejected on the now-committed finalized status.
        expect(result.ok).toBe(false);
        const err = (result as { ok: false; error: { message: string; code?: string } }).error;
        expect(err.message).toMatch(FINALIZED_MSG);
        expect(err.code).not.toBe("40P01"); // never a deadlock

        // 4. The pre-finalization area set survives intact.
        expect((await areaSnapshot(blockId)).map((r) => r.area)).toEqual(["Cheek", "Sideburn"]);
      });
    });
  });
});
